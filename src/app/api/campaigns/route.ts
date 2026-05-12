import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { listCampaigns } from '@/campaigns/persist';
import { createCampaign } from '@/campaigns/forge';
import { validateCreateBody } from '@/campaigns/validate';

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
