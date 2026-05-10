import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, characters } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { checkQuotas } from '@/ai/master/quotas';
import { abilityModifier } from '@/engine/modifiers';
import { deriveLevel1Spellcasting } from '@/characters/derive';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .orderBy(desc(sessions.updatedAt));
  return NextResponse.json({ sessions: rows });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { characterId?: string; premise?: string } | null;
  if (!body?.characterId || !body?.premise) {
    return NextResponse.json({ error: 'missing-fields' }, { status: 400 });
  }
  await ensureUser(userId);

  const quota = await checkQuotas({ userId, kind: 'create_session' });
  if (!quota.ok) return NextResponse.json({ error: quota.reason }, { status: 429 });

  const [template] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, body.characterId), eq(characters.userId, userId), isNull(characters.deletedAt)))
    .limit(1);
  if (!template) return NextResponse.json({ error: 'character-not-found' }, { status: 404 });

  // Per-campaign isolation (PHB single-player): a template character can be
  // played in many campaigns without progression bleeding across them. We
  // deep-copy the template into a session-bound *instance* (templateId set
  // to the template's id). All in-game mutations (level-up, XP, inventory,
  // spell slots, attunement, classes, etc.) write to the instance row, so
  // the template remains pristine and reusable for future campaigns.
  //
  // Backward-compat: if the user passed an instance id (templateId NOT
  // NULL), we treat it as already-forked and reuse it. This shouldn't
  // happen under normal flow but keeps re-creation idempotent if the
  // client retries.
  let sessionCharacterId: string;
  let instanceHpMax: number;
  let instanceHitDiceMax: number;
  if (template.templateId) {
    sessionCharacterId = template.id;
    instanceHpMax = template.hpMax;
    instanceHitDiceMax = template.hitDiceMax;
  } else {
    // Reset all per-campaign mutable fields to a fresh Level-1 state. The
    // template might already be contaminated by previous bug-era sessions
    // (level-ups, loot, attunement, etc. were written back to the
    // template). Forking the contaminated state into a new campaign would
    // hand the player a level-2 wizard with a longsword — exactly the
    // bug the user reported. So when we fork, we override the mutable
    // fields with their L1 derived values; identity / abilities / race /
    // class / background (the static "template" parts) are preserved.
    const conMod = abilityModifier(template.abilities.CON);
    const dexMod = abilityModifier(template.abilities.DEX);
    const freshHpMax = template.hitDieSize + conMod;
    const freshAc = 10 + dexMod;
    const freshSpellcasting = deriveLevel1Spellcasting(template.classSlug, template.abilities, 2);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _ignore, createdAt: _c, updatedAt: _u, ...templateData } = template;
    const [instance] = await db
      .insert(characters)
      .values({
        ...templateData,
        templateId: template.id,
        // ── Reset progression / state to L1 fresh ──
        level: 1,
        xp: 0,
        proficiencyBonus: 2,
        hpMax: freshHpMax,
        ac: freshAc,
        hitDiceMax: 1,
        classes: [{ slug: template.classSlug, level: 1 }],
        spellcasting: freshSpellcasting,
        spellsKnown: freshSpellcasting?.spellsKnown ?? [],
        features: [],
        inventory: [],
        // ── Reset Phase 4-14 fields ──
        inspiration: false,
        attunedItems: [],
        senses: null,
        equippedFocus: null,
        craftingProjects: [],
        downtimeActivities: [],
        hirelings: [],
        bastion: null,
        mountedOn: null,
        embarkedOn: null,
      })
      .returning();
    if (!instance) return NextResponse.json({ error: 'fork-failed' }, { status: 500 });
    sessionCharacterId = instance.id;
    instanceHpMax = freshHpMax;
    instanceHitDiceMax = 1;
  }

  const [session] = await db.insert(sessions).values({ userId, characterId: sessionCharacterId, premise: body.premise }).returning();
  await db.insert(sessionState).values({
    sessionId: session!.id,
    hpCurrent: instanceHpMax,
    hitDiceRemaining: instanceHitDiceMax,
  });
  return NextResponse.json({ id: session!.id });
}
