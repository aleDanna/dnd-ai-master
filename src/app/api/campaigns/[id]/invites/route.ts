import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns } from '@/db/schema';
import { createInvite, listActiveInvites } from '@/multiplayer/invites';

type Ctx = { params: Promise<{ id: string }> };

async function requireHost(userId: string, campaignId: string): Promise<boolean> {
  const [c] = await db.select({ userId: campaigns.userId }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  return !!c && c.userId === userId;
}

function originFromReq(req: NextRequest): string {
  return req.headers.get('origin') ?? `https://${req.headers.get('host') ?? 'localhost:3000'}`;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: campaignId } = await ctx.params;
  if (!(await requireHost(userId, campaignId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: 'expiresAt-in-past' }, { status: 422 });
  }
  const maxUses = typeof body.maxUses === 'number' && body.maxUses > 0 ? body.maxUses : null;

  const invite = await createInvite({
    campaignId,
    createdByUserId: userId,
    expiresAt,
    maxUses,
  });

  const url = `${originFromReq(req)}/r/${invite.token}`;
  return NextResponse.json({ invite, url }, { status: 201 });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: campaignId } = await ctx.params;
  if (!(await requireHost(userId, campaignId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const invites = await listActiveInvites(campaignId);
  return NextResponse.json({ invites });
}
