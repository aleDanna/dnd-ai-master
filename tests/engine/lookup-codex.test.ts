import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, codexEntities } from '@/db/schema';
import { lookupCodex } from '@/engine/tools/lookup-codex';

const TEST_USER = 'user_lookup_' + Date.now();
let SESSION_ID = '';

describe('lookup_codex handler', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: c.id, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
    await db.insert(codexEntities).values([
      {
        sessionId: SESSION_ID,
        kind: 'npc',
        slug: 'aldric-the-grey',
        name: 'Aldric the Grey',
        data: { description: 'old wizard', status: 'alive', disposition: 'ally', tags: [] },
      },
      {
        sessionId: SESSION_ID,
        kind: 'npc',
        slug: 'aldis',
        name: 'Aldis',
        data: { description: 'thief', status: 'alive', disposition: 'neutral', tags: [] },
      },
      {
        sessionId: SESSION_ID,
        kind: 'location',
        slug: 'silver-tavern',
        name: 'Silver Tavern',
        data: { description: 'cozy inn', tags: ['inn'] },
      },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('returns matching NPCs for fuzzy substring on name', async () => {
    const r = await lookupCodex({ sessionId: SESSION_ID }, { kind: 'npc', query: 'ald' });
    expect(r.ok).toBe(true);
    const data = r.data as { matches: { slug: string }[] };
    expect(data.matches.map((m) => m.slug).sort()).toEqual(['aldis', 'aldric-the-grey']);
  });

  it('matches on slug as well', async () => {
    const r = await lookupCodex({ sessionId: SESSION_ID }, { kind: 'npc', query: 'aldric-the' });
    const data = r.data as { matches: { slug: string }[] };
    expect(data.matches.map((m) => m.slug)).toEqual(['aldric-the-grey']);
  });

  it('filters by kind', async () => {
    const r = await lookupCodex({ sessionId: SESSION_ID }, { kind: 'location', query: 'tavern' });
    const data = r.data as { matches: { slug: string }[] };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]!.slug).toBe('silver-tavern');
  });

  it('returns empty matches array when nothing fits', async () => {
    const r = await lookupCodex({ sessionId: SESSION_ID }, { kind: 'npc', query: 'zzzzz' });
    const data = r.data as { matches: unknown[] };
    expect(data.matches).toEqual([]);
  });

  it('returns error on invalid kind', async () => {
    const r = await lookupCodex({ sessionId: SESSION_ID }, { kind: 'bogus', query: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid_kind');
  });
});
