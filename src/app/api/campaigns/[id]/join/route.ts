import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, isNotNull, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaignInvites, characters, sessions } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { resolveToken } from '@/multiplayer/invites';
import { forkTemplateForCampaign } from '@/campaigns/fork';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);

  const { id: campaignId } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== 'string' || typeof body.characterTemplateId !== 'string') {
    return NextResponse.json({ error: 'missing-fields' }, { status: 422 });
  }

  // 1. Validate token
  const invite = await resolveToken(body.token);
  if (!invite || invite.campaignId !== campaignId) {
    return NextResponse.json({ error: 'invite-not-valid' }, { status: 410 });
  }

  // 2. Check if user is already in the party (has an instance character in this campaign)
  const [existing] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.campaignId, campaignId),
        eq(characters.userId, userId),
        isNotNull(characters.templateId),
        isNull(characters.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)))
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    return NextResponse.json({ error: 'already-in-party', sessionId: session?.id }, { status: 409 });
  }

  // 3. Execute in a transaction: fork template, find active session
  try {
    const result = await db.transaction(async (tx) => {
      // Fork the template (validates existence, ownership, and that it's a template)
      await forkTemplateForCampaign({
        tx,
        userId,
        characterId: body.characterTemplateId,
        campaignId,
      });

      // Increment invite uses atomically inside the transaction
      await tx
        .update(campaignInvites)
        .set({ usesCount: sql`uses_count + 1` })
        .where(eq(campaignInvites.id, invite.id));

      // Find the active session for this campaign
      const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)))
        .orderBy(desc(sessions.updatedAt))
        .limit(1);

      if (!session) throw new Error('no-active-session');
      return { sessionId: session.id };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg === 'character-not-found') return NextResponse.json({ error: msg }, { status: 404 });
    if (msg === 'character-forbidden') return NextResponse.json({ error: msg }, { status: 403 });
    if (msg === 'not-a-template') return NextResponse.json({ error: msg }, { status: 422 });
    if (msg === 'no-active-session') return NextResponse.json({ error: msg }, { status: 409 });
    console.error('join failed:', err);
    return NextResponse.json({ error: 'join-failed' }, { status: 500 });
  }
}
