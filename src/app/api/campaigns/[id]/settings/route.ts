import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { getCampaign } from '@/campaigns/persist';
import {
  getCampaignSettings,
  updateCampaignSettings,
  validateSettingsPatch,
  type CampaignSettings,
} from '@/lib/preferences';

const ALLOWED_KEYS: ReadonlySet<keyof CampaignSettings> = new Set<keyof CampaignSettings>([
  'aiProvider',
  'aiMasterModel',
  'ttsProvider',
  'ttsVoice',
  'ttsModel',
  'manualRolls',
  'masterGuidanceLevel',
  'showDifficultyNumbers',
  'narrationPace',
  'imageGenerationEnabled',
  'imageStylePreset',
  'imageStyleCustom',
  'imageProvider',
  'imageModel',
  'compactPrompt',
  'useModeAwarePrompt',
  'useRagRetrieval',
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);
  const { id } = await params;

  const data = await getCampaign(userId, id);
  if (!data) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const settings = await getCampaignSettings(id);
  return NextResponse.json({
    settings,
    canEdit: data.campaign.userId === userId,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);
  const { id } = await params;

  const data = await getCampaign(userId, id);
  if (!data) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (data.campaign.userId !== userId) {
    return NextResponse.json({ error: 'host-only' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 });
  }

  // Pull `language` out before validation — it's a separate `campaigns.language`
  // column, not a CampaignSettings JSONB key. Accept null/empty (auto-detect on
  // first turn) or an ISO 639-1 lowercase 2-letter code.
  let languagePatch: string | null | undefined;
  if ('language' in body) {
    const v = body.language;
    if (v === null || v === '' || v === undefined) {
      languagePatch = null;  // reset to auto-detect
    } else if (typeof v === 'string' && /^[a-z]{2}$/.test(v)) {
      languagePatch = v;
    } else {
      return NextResponse.json({ error: 'invalid-language' }, { status: 400 });
    }
    delete body.language;
  }

  // Reject any key that isn't a valid CampaignSettings field. Surfaces stale
  // clients (or typos) instead of silently dropping the patch on the floor.
  // Notably this also rejects ttsAutoplay, which lives on users.preferences.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key as keyof CampaignSettings)) {
      return NextResponse.json({ error: 'unknown-key', key }, { status: 400 });
    }
  }

  // Pass the current stored settings as the validator's `stored` context so a
  // partial patch like { aiMasterModel: 'qwen3:30b-a3b' } (no aiProvider)
  // can still be resolved against the stored aiProvider='local'.
  const currentSettings = await getCampaignSettings(id);
  const result = validateSettingsPatch(body as Partial<CampaignSettings>, {
    aiProvider: currentSettings.aiProvider,
    ttsProvider: currentSettings.ttsProvider,
    ttsModel: currentSettings.ttsModel,
    imageProvider: currentSettings.imageProvider,
  });
  // eslint-disable-next-line no-console
  console.log('[settings-PUT] body=', JSON.stringify(body), 'validated=', JSON.stringify(result), 'env.PIPER=', !!process.env.PIPER_BASE_URL, 'env.XTTS=', !!process.env.XTTS_BASE_URL, 'env.OLLAMA=', !!process.env.OLLAMA_BASE_URL, 'NODE_ENV=', process.env.NODE_ENV, 'VERCEL=', !!process.env.VERCEL);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Patch came through ALLOWED_KEYS — no ttsAutoplay possible. Persist as-is.
  await updateCampaignSettings(id, result.patch as Partial<CampaignSettings>);

  // Language lives on its own column; update separately if requested.
  if (languagePatch !== undefined) {
    await db.update(campaigns)
      .set({ language: languagePatch, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)));
  }

  const settings = await getCampaignSettings(id);
  // Re-read the campaign row to surface the (possibly updated) language column.
  const [row] = await db
    .select({ language: campaigns.language })
    .from(campaigns)
    .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)))
    .limit(1);
  const language = row?.language ?? null;
  // eslint-disable-next-line no-console
  console.log('[settings-PUT] returning settings=', JSON.stringify({ aiProvider: settings.aiProvider, ttsProvider: settings.ttsProvider, ttsModel: settings.ttsModel, ttsVoice: settings.ttsVoice, imageProvider: settings.imageProvider, language }));
  return NextResponse.json({ settings, language });
}
