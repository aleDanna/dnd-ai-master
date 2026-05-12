import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getCampaign, renameCampaign, softDeleteCampaign } from '@/campaigns/persist';
import { validatePatchBody } from '@/campaigns/validate';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const row = await getCampaign(userId, id);
  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const raw = await req.json().catch(() => null);
  const parsed = validatePatchBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 422 });
  const row = await renameCampaign(userId, id, parsed.value.name);
  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return NextResponse.json({ campaign: row });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const ok = await softDeleteCampaign(userId, id);
  if (!ok) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
