import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
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

  // Reject any key that isn't a valid CampaignSettings field. Surfaces stale
  // clients (or typos) instead of silently dropping the patch on the floor.
  // Notably this also rejects ttsAutoplay, which lives on users.preferences.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key as keyof CampaignSettings)) {
      return NextResponse.json({ error: 'unknown-key', key }, { status: 400 });
    }
  }

  const result = validateSettingsPatch(body as Partial<CampaignSettings>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Patch came through ALLOWED_KEYS — no ttsAutoplay possible. Persist as-is.
  await updateCampaignSettings(id, result.patch as Partial<CampaignSettings>);

  const settings = await getCampaignSettings(id);
  return NextResponse.json({ settings });
}
