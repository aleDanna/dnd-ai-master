import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { listCampaigns } from '@/campaigns/persist';
import { createCampaign } from '@/campaigns/forge';
import { validateCreateBody } from '@/campaigns/validate';
import { seedCampaignVault } from '@/campaigns/seed-vault';
import { resolveMasterBackend } from '@/lib/preferences';

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const status = statusParam === 'active' || statusParam === 'ended' ? statusParam : undefined;
  const rows = await listCampaigns(userId, status);
  return NextResponse.json({ campaigns: rows });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);

  const raw = await req.json().catch(() => null);
  const parsed = validateCreateBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 422 });

  try {
    const result = await createCampaign({ userId, ...parsed.value });
    // Seed the vault genesis (campaign_initialized) AFTER the creation tx
    // commits — the filesystem seed must not run inside the DB tx (see
    // forge.ts). New campaigns are born masterBackend=vault + vaultMutations=
    // true, but the flag-keyed enableMutationsForCampaign would skip them, so
    // the genesis MUST be written here or materializeFromVault returns null and
    // the client snapshot silently falls back to Postgres (inCombat=false, no
    // CombatTracker). seedCampaignVault is idempotent (event-keyed) + best-
    // effort: a seed failure must not fail an already-committed creation.
    if (resolveMasterBackend(result.campaign.settings.masterBackend) === 'vault') {
      try {
        await seedCampaignVault(result.campaign.id);
      } catch (seedErr) {
        console.error('seedCampaignVault failed for', result.campaign.id, seedErr);
      }
    }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'character-not-found') return NextResponse.json({ error: message }, { status: 404 });
    if (message === 'character-forbidden') return NextResponse.json({ error: message }, { status: 403 });
    if (message === 'not-a-template') return NextResponse.json({ error: message }, { status: 422 });
    console.error('createCampaign failed:', err);
    return NextResponse.json({ error: 'create-failed' }, { status: 500 });
  }
}
