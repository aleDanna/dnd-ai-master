import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns } from '@/db/schema';
import { revokeInvite } from '@/multiplayer/invites';

type Ctx = { params: Promise<{ id: string; inviteId: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: campaignId, inviteId } = await ctx.params;

  const [c] = await db.select({ userId: campaigns.userId }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))).limit(1);
  if (!c || c.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const ok = await revokeInvite(inviteId, campaignId);
  if (!ok) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
