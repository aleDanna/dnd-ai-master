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

  // Reject ttsAutoplay — it lives on users.preferences, not campaigns.settings.
  if ('ttsAutoplay' in body) {
    return NextResponse.json({ error: 'unknown-key', key: 'ttsAutoplay' }, { status: 400 });
  }

  const result = validateSettingsPatch(body as Partial<CampaignSettings>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // validateSettingsPatch returns the superset (incl. ttsAutoplay) but we
  // already rejected ttsAutoplay above, so the patch is safe to persist.
  const { ttsAutoplay: _ignored, ...campaignPatch } = result.patch;
  void _ignored;
  await updateCampaignSettings(id, campaignPatch);

  const settings = await getCampaignSettings(id);
  return NextResponse.json({ settings });
}
