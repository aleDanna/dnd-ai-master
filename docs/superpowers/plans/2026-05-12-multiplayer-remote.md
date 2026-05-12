# Multiplayer Remote Minimum Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable N-player synchronous remote multiplayer within a single campaign via opaque invite tokens, unified SSE stream backed by Postgres LISTEN/NOTIFY, and master-decided turn discipline with server-side fallback round-robin.

**Architecture:** New `campaign_invites` table + 3 cols on `sessions` + 1 col on `session_messages`. Unified `/api/sessions/[id]/stream` SSE endpoint replaces both `use-session-state` and `use-turn-stream` client hooks. `POST /turn` becomes fire-and-forget (returns 202); master chunks broadcast to all party clients via `notifySession()`. Master loop adds `set_current_player(characterId)` tool with 3-turn round-robin fallback.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle ORM · Postgres LISTEN/NOTIFY · Clerk auth · Vitest · Playwright. No new external dependencies.

**Spec:** [docs/superpowers/specs/2026-05-12-multiplayer-remote-design.md](../specs/2026-05-12-multiplayer-remote-design.md)

---

## File structure

**Create**

- `src/db/schema/campaign-invites.ts` — Drizzle schema for `campaign_invites`
- `src/multiplayer/token.ts` — `generateInviteToken()` + `isInviteValid()`
- `src/multiplayer/invites.ts` — invite persist (create, list, revoke, resolve)
- `src/multiplayer/party.ts` — `listParty(campaignId)` + `nextInParty(currentId, party)` round-robin helper
- `src/multiplayer/access.ts` — `checkPartyAccess(userId, sessionId)` permission helper
- `src/sessions/notify.ts` — `notifySession(sessionId, payload)` helper
- `src/sessions/use-session-stream.ts` — unified client hook (replaces use-session-state + use-turn-stream)
- `src/app/api/campaigns/[id]/invites/route.ts` — POST + GET
- `src/app/api/campaigns/[id]/invites/[inviteId]/route.ts` — DELETE
- `src/app/api/r/[token]/route.ts` — GET resolve token
- `src/app/api/campaigns/[id]/join/route.ts` — POST join
- `src/app/api/sessions/[id]/stream/route.ts` — GET SSE stream
- `src/app/(authed)/r/[token]/page.tsx` — server resolve+redirect
- `src/app/(authed)/r/[token]/expired.tsx` — expired invite card
- `src/app/(authed)/campaigns/[id]/join/page.tsx` — server fetches templates, may redirect to wizard
- `src/app/(authed)/campaigns/[id]/join/join-client.tsx` — client template picker + submit
- `src/components/sessions/party-strip.tsx` — party row component
- `src/components/campaigns/invite-section.tsx` — invite link block on detail page (host only)
- Tests: `tests/multiplayer/token.test.ts`, `tests/multiplayer/party.test.ts`, `tests/api/multiplayer.test.ts`, `tests/api/sessions-stream.test.ts`, `tests/ai/master/multiplayer-loop.test.ts`, `tests/e2e/multiplayer.spec.ts`

**Modify**

- `src/db/schema/sessions.ts` — add `currentPlayerCharacterId`, `turnSeq`, `turnsSinceMasterAdvance`
- `src/db/schema/session-messages.ts` — add `authorCharacterId`
- `src/db/schema/index.ts` — export campaign-invites
- `src/sessions/snapshot.ts` — return party array + `currentPlayerCharacterId` + `viewerCharacterId`
- `src/sessions/applicator.ts` — call `notifySession()` on state/dice mutations
- `src/ai/master/system-prompt.ts` — PARTY MODE block
- `src/ai/master/tools.ts` (or equivalent) — register `set_current_player` tool
- `src/app/api/sessions/[id]/turn/route.ts` — permission check, fire-and-forget pattern, post-loop hook
- `src/app/api/sessions/[id]/route.ts` — response includes `party`
- `src/app/(authed)/sessions/[id]/page.tsx` — uses new hook, passes party
- `src/app/(authed)/sessions/[id]/game-client.tsx` — party strip + composer gating + author-aware bubbles
- `src/app/(authed)/campaigns/[id]/page.tsx` — invite section (host) + party list
- `src/app/(authed)/characters/new/wizard-client.tsx` — `?returnTo=` support
- Test fixtures inserting `session_messages` with `role='player'` — add `author_character_id`

---

## Phase 1 — Database schema & migration

### Task 1: Drizzle schema for `campaign_invites`

**Files:**
- Create: `src/db/schema/campaign-invites.ts`
- Modify: `src/db/schema/index.ts`

- [ ] **Step 1: Create the schema file**

```typescript
// src/db/schema/campaign-invites.ts
import { pgTable, text, uuid, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';
import { users } from './users';

export const campaignInvites = pgTable(
  'campaign_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    createdByUserId: text('created_by_user_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    usesCount: integer('uses_count').notNull().default(0),
  },
  (t) => ({
    tokenIdx: index('campaign_invites_token_idx').on(t.token),
    campaignIdx: index('campaign_invites_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignInvite = typeof campaignInvites.$inferSelect;
export type CampaignInviteInsert = typeof campaignInvites.$inferInsert;
```

- [ ] **Step 2: Export from index**

In `src/db/schema/index.ts`, add: `export * from './campaign-invites';` next to the other campaign export.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/campaign-invites.ts src/db/schema/index.ts
git commit -m "feat(db): add campaign_invites Drizzle schema"
```

---

### Task 2: Add columns to `sessions` and `session_messages`

**Files:**
- Modify: `src/db/schema/sessions.ts`
- Modify: `src/db/schema/session-messages.ts`

- [ ] **Step 1: Add columns to sessions**

In `src/db/schema/sessions.ts`, after `engagementProfile` and before `campaignId`, add:

```typescript
    /**
     * Multiplayer (#6): the character whose turn it is to act. NULL until
     * the session has its first character (solo backfill sets this at
     * migration time; multiplayer create sets it to host's character).
     * Updated by master tool set_current_player or server-side round-robin
     * fallback after 3 consecutive turns without a tool call.
     */
    currentPlayerCharacterId: uuid('current_player_character_id').references(() => characters.id),
    /**
     * Multiplayer (#6): monotonic turn counter. Incremented at the end of
     * every master turn, including fallback turns.
     */
    turnSeq: integer('turn_seq').notNull().default(0),
    /**
     * Multiplayer (#6): counts turns since the master last called
     * set_current_player. Reset to 0 by the tool handler. When the
     * post-loop hook reads >= 3, server-side round-robin advances the
     * current player and resets the counter.
     */
    turnsSinceMasterAdvance: integer('turns_since_master_advance').notNull().default(0),
```

Also add `integer` to the import line at the top of the file. And `characters` import if not already present.

- [ ] **Step 2: Add column to session_messages**

In `src/db/schema/session-messages.ts`, find the existing column block and add:

```typescript
    /**
     * Multiplayer (#6): the character that authored this message. NULL for
     * role='master' and role='system' rows. Populated for role='player'.
     */
    authorCharacterId: uuid('author_character_id').references(() => characters.id, { onDelete: 'set null' }),
```

Add `characters` import from `./characters` if not present.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/sessions.ts src/db/schema/session-messages.ts
git commit -m "feat(db): add multiplayer columns to sessions + session_messages"
```

---

### Task 3: Generate Drizzle migration

**Files:**
- Create: `drizzle/<NNNN>_<auto>.sql` (auto-generated, likely `0029_*`)

- [ ] **Step 1: Run db:generate**

Ensure `.env.local` symlink is in place (created during campaign management work; if missing, run `ln -s /Users/alessiodanna/projects/dnd-ai-master/.env.local .env.local` from the worktree).

Run: `pnpm db:generate`
Expected: a new file `drizzle/0029_<adjective_noun>.sql` containing:
- `CREATE TABLE "campaign_invites" (...)` with all columns
- Three `ALTER TABLE "sessions" ADD COLUMN ...` statements
- One `ALTER TABLE "session_messages" ADD COLUMN ...` statement
- Two `CREATE INDEX` for campaign_invites
- FK constraint statements

If a different number is generated (e.g. another migration landed first), use the actual filename in subsequent commands.

- [ ] **Step 2: Inspect the generated SQL**

Read the file. Verify it contains all expected statements above. No spurious `DROP` or unexpected modifications.

- [ ] **Step 3: Commit the generated migration**

```bash
git add drizzle/0029_*.sql drizzle/meta/
git commit -m "feat(db): generate migration 0029 for multiplayer"
```

---

### Task 4: Append backfill SQL to migration

**Files:**
- Modify: `drizzle/0029_*.sql` (the file from Task 3)

- [ ] **Step 1: Append the backfill block at the end of the migration file**

Append exactly:

```sql
--> statement-breakpoint
-- ── Multiplayer backfill ──
-- Existing sessions: current_player_character_id = the (only) character
-- Existing player messages: author_character_id = session's character

UPDATE sessions
SET current_player_character_id = character_id
WHERE current_player_character_id IS NULL;

UPDATE session_messages sm
SET author_character_id = s.character_id
FROM sessions s
WHERE sm.session_id = s.id
  AND sm.role = 'player'
  AND sm.author_character_id IS NULL;
```

- [ ] **Step 2: Run the migration locally**

Run: `pnpm db:migrate`
Expected: migration applies successfully.

- [ ] **Step 3: Verify the backfill in the local DB**

```bash
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM sessions WHERE current_player_character_id IS NULL AND deleted_at IS NULL;"
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM session_messages WHERE role = 'player' AND author_character_id IS NULL;"
```

Both should return `0` (assuming there were existing rows to backfill).

- [ ] **Step 4: Commit**

```bash
git add drizzle/0029_*.sql
git commit -m "feat(db): backfill current_player + author_character_id in 0029"
```

---

## Phase 2 — Domain logic

### Task 5: Invite token generator + validity helper

**Files:**
- Create: `src/multiplayer/token.ts`
- Create: `tests/multiplayer/token.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multiplayer/token.test.ts
import { describe, it, expect } from 'vitest';
import { generateInviteToken, isInviteValid } from '@/multiplayer/token';

describe('generateInviteToken', () => {
  it('returns a 12-char URL-safe string', () => {
    const t = generateInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
  it('produces unique tokens across calls', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateInviteToken()));
    expect(set.size).toBe(100);
  });
});

describe('isInviteValid', () => {
  const base = { revokedAt: null, expiresAt: null, maxUses: null, usesCount: 0 };
  const now = new Date('2026-05-12T12:00:00Z');

  it('accepts an active unbounded invite', () => {
    expect(isInviteValid(base, now)).toBe(true);
  });
  it('rejects a revoked invite', () => {
    expect(isInviteValid({ ...base, revokedAt: new Date('2026-05-11T00:00:00Z') }, now)).toBe(false);
  });
  it('rejects an expired invite', () => {
    expect(isInviteValid({ ...base, expiresAt: new Date('2026-05-11T00:00:00Z') }, now)).toBe(false);
  });
  it('accepts an invite expiring in the future', () => {
    expect(isInviteValid({ ...base, expiresAt: new Date('2026-05-13T00:00:00Z') }, now)).toBe(true);
  });
  it('rejects a maxed-out invite', () => {
    expect(isInviteValid({ ...base, maxUses: 5, usesCount: 5 }, now)).toBe(false);
  });
  it('accepts an invite below max uses', () => {
    expect(isInviteValid({ ...base, maxUses: 5, usesCount: 3 }, now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm vitest run tests/multiplayer/token.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/multiplayer/token.ts
import { randomBytes } from 'node:crypto';

/** Generate a 12-char URL-safe random invite token. */
export function generateInviteToken(): string {
  return randomBytes(9).toString('base64url');
}

export type InviteValidityInput = {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usesCount: number;
};

/** Check whether an invite is currently usable. */
export function isInviteValid(invite: InviteValidityInput, now: Date = new Date()): boolean {
  if (invite.revokedAt) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() < now.getTime()) return false;
  if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return false;
  return true;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm vitest run tests/multiplayer/token.test.ts`
Expected: PASS — 8 assertions.

- [ ] **Step 5: Commit**

```bash
git add src/multiplayer/token.ts tests/multiplayer/token.test.ts
git commit -m "feat(multiplayer): invite token generator + validity helper"
```

---

### Task 6: Party round-robin helper

**Files:**
- Create: `src/multiplayer/party.ts`
- Create: `tests/multiplayer/party.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/multiplayer/party.test.ts
import { describe, it, expect } from 'vitest';
import { nextInParty } from '@/multiplayer/party';

type Char = { id: string; createdAt: Date };
const party: Char[] = [
  { id: 'a', createdAt: new Date('2026-05-01T10:00:00Z') },
  { id: 'b', createdAt: new Date('2026-05-01T10:05:00Z') },
  { id: 'c', createdAt: new Date('2026-05-01T10:10:00Z') },
];

describe('nextInParty', () => {
  it('returns the next character in created-at order', () => {
    expect(nextInParty('a', party).id).toBe('b');
    expect(nextInParty('b', party).id).toBe('c');
  });
  it('wraps around at the end', () => {
    expect(nextInParty('c', party).id).toBe('a');
  });
  it('returns the first character when current is not in party', () => {
    expect(nextInParty('zzz', party).id).toBe('a');
  });
  it('returns the only character when party has one', () => {
    expect(nextInParty('solo', [{ id: 'solo', createdAt: new Date() }]).id).toBe('solo');
  });
  it('throws on empty party', () => {
    expect(() => nextInParty('a', [])).toThrow(/empty/);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm vitest run tests/multiplayer/party.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/multiplayer/party.ts

export type PartyMember = { id: string; createdAt: Date };

/**
 * Given a sorted-by-created-at party and the current character's id, return
 * the next character. Wraps around. If the current id isn't in the party,
 * returns the first. Throws on empty party.
 */
export function nextInParty<T extends PartyMember>(currentId: string, party: T[]): T {
  if (party.length === 0) throw new Error('empty party');
  const idx = party.findIndex((c) => c.id === currentId);
  if (idx === -1) return party[0]!;
  return party[(idx + 1) % party.length]!;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm vitest run tests/multiplayer/party.test.ts`
Expected: PASS — 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/multiplayer/party.ts tests/multiplayer/party.test.ts
git commit -m "feat(multiplayer): party round-robin helper"
```

---

### Task 7: Invite persist module

**Files:**
- Create: `src/multiplayer/invites.ts`

- [ ] **Step 1: Implement**

```typescript
// src/multiplayer/invites.ts
import { and, eq, isNull, gt, sql, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaignInvites, type CampaignInvite } from '@/db/schema';
import { generateInviteToken, isInviteValid } from './token';

export type CreateInviteInput = {
  campaignId: string;
  createdByUserId: string;
  expiresAt?: Date | null;
  maxUses?: number | null;
};

export async function createInvite(input: CreateInviteInput): Promise<CampaignInvite> {
  // Token uniqueness retry loop (collision near-impossible with 12-char base64url).
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateInviteToken();
    try {
      const [row] = await db
        .insert(campaignInvites)
        .values({
          campaignId: input.campaignId,
          token,
          createdByUserId: input.createdByUserId,
          expiresAt: input.expiresAt ?? null,
          maxUses: input.maxUses ?? null,
        })
        .returning();
      if (!row) throw new Error('invite-insert-failed');
      return row;
    } catch (err) {
      if (attempt === 4) throw err;
      // Retry on token collision
    }
  }
  throw new Error('invite-create-exhausted-retries');
}

/** List active (non-revoked, non-expired, non-maxed) invites for a campaign. */
export async function listActiveInvites(campaignId: string): Promise<CampaignInvite[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(campaignInvites)
    .where(and(
      eq(campaignInvites.campaignId, campaignId),
      isNull(campaignInvites.revokedAt),
    ))
    .orderBy(desc(campaignInvites.createdAt));
  return rows.filter((r) => isInviteValid(r, now));
}

export async function revokeInvite(inviteId: string): Promise<boolean> {
  const [row] = await db
    .update(campaignInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(campaignInvites.id, inviteId), isNull(campaignInvites.revokedAt)))
    .returning({ id: campaignInvites.id });
  return !!row;
}

/** Resolve a token. Returns null if not found / not valid. */
export async function resolveToken(token: string): Promise<CampaignInvite | null> {
  const [row] = await db
    .select()
    .from(campaignInvites)
    .where(eq(campaignInvites.token, token))
    .limit(1);
  if (!row) return null;
  if (!isInviteValid(row)) return null;
  return row;
}

/** Atomic increment of uses_count (used by the join flow). */
export async function incrementInviteUses(inviteId: string): Promise<void> {
  await db
    .update(campaignInvites)
    .set({ usesCount: sql`uses_count + 1` })
    .where(eq(campaignInvites.id, inviteId));
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/multiplayer/invites.ts
git commit -m "feat(multiplayer): invite persist module (create, list, revoke, resolve)"
```

---

### Task 8: notifySession helper

**Files:**
- Create: `src/sessions/notify.ts`

- [ ] **Step 1: Implement**

```typescript
// src/sessions/notify.ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export type NotifyPayload =
  | { type: 'message-chunk'; messageId: string; text: string }
  | { type: 'message'; messageId: string }
  | { type: 'state' }
  | { type: 'turn-change'; characterId: string }
  | { type: 'dice'; logId: string };

/**
 * Emit a Postgres NOTIFY on channel `session_<id>`. All SSE subscribers
 * for this session receive the payload via LISTEN. Payload size is capped
 * by Postgres at 8000 bytes; we defensively drop if over 7900.
 */
export async function notifySession(sessionId: string, payload: NotifyPayload): Promise<void> {
  const json = JSON.stringify(payload);
  if (json.length > 7900) {
    console.warn('notifySession: payload too large, dropping', { sessionId, type: payload.type, size: json.length });
    return;
  }
  const channel = `session_${sessionId}`;
  await db.execute(sql`SELECT pg_notify(${channel}, ${json})`);
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/notify.ts
git commit -m "feat(sessions): notifySession helper for pg_notify"
```

---

### Task 9: Party access helper

**Files:**
- Create: `src/multiplayer/access.ts`

- [ ] **Step 1: Implement**

```typescript
// src/multiplayer/access.ts
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters, sessions } from '@/db/schema';

/**
 * Returns true if `userId` is allowed to subscribe to/read session events:
 * either owns a non-deleted instance character in the campaign, or is the
 * campaign's host.
 */
export async function checkPartyAccess(userId: string, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ campaignUserId: campaigns.userId, campaignId: campaigns.id })
    .from(sessions)
    .innerJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return false;

  if (row.campaignUserId === userId) return true;  // host

  const [member] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(
      eq(characters.campaignId, row.campaignId),
      eq(characters.userId, userId),
      isNotNull(characters.templateId),
      isNull(characters.deletedAt),
    ))
    .limit(1);
  return !!member;
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/multiplayer/access.ts
git commit -m "feat(multiplayer): checkPartyAccess permission helper"
```

---

## Phase 3 — API routes

### Task 10: POST/GET /api/campaigns/[id]/invites

**Files:**
- Create: `src/app/api/campaigns/[id]/invites/route.ts`
- Create: `tests/api/multiplayer.test.ts`

- [ ] **Step 1: Write failing test (POST happy + 403 + invalid expiresAt)**

```typescript
// tests/api/multiplayer.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns } from '@/db/schema';
import { POST as postInvite, GET as listInvites } from '@/app/api/campaigns/[id]/invites/route';

const HOST = 'user_mp_host_001';
const GUEST = 'user_mp_guest_001';
let CURRENT_USER = HOST;

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: CURRENT_USER }),
}));

let campaignId: string;

beforeAll(async () => {
  await db.insert(users).values([
    { id: HOST, displayName: 'Host' },
    { id: GUEST, displayName: 'Guest' },
  ]).onConflictDoNothing();
  const [c] = await db.insert(campaigns).values({
    userId: HOST,
    name: 'MP Test',
    premise: 'A test multiplayer campaign.',
  }).returning();
  campaignId = c!.id;
});

afterAll(async () => {
  await db.execute(`DELETE FROM users WHERE id IN ('${HOST}', '${GUEST}')`);
  await pool.end();
});

describe('POST /api/campaigns/[id]/invites', () => {
  it('host creates an invite', async () => {
    CURRENT_USER = HOST;
    const req = new Request('http://t', { method: 'POST', body: JSON.stringify({}) });
    const res = await postInvite(req as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invite.token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(body.url).toContain(body.invite.token);
  });

  it('guest gets 403', async () => {
    CURRENT_USER = GUEST;
    const req = new Request('http://t', { method: 'POST', body: JSON.stringify({}) });
    const res = await postInvite(req as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(403);
  });

  it('rejects expiresAt in the past', async () => {
    CURRENT_USER = HOST;
    const req = new Request('http://t', {
      method: 'POST',
      body: JSON.stringify({ expiresAt: '2020-01-01T00:00:00Z' }),
    });
    const res = await postInvite(req as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/campaigns/[id]/invites', () => {
  it('host lists active invites', async () => {
    CURRENT_USER = HOST;
    const res = await listInvites(new Request('http://t') as any, { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.invites)).toBe(true);
    expect(body.invites.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, expect fail (module missing)**

Run: `pnpm vitest run tests/api/multiplayer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

```typescript
// src/app/api/campaigns/[id]/invites/route.ts
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
```

- [ ] **Step 4: Run tests, expect pass**

Run: `pnpm vitest run tests/api/multiplayer.test.ts`
Expected: PASS — 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/campaigns/[id]/invites/route.ts tests/api/multiplayer.test.ts
git commit -m "feat(api): POST + GET /api/campaigns/[id]/invites"
```

---

### Task 11: DELETE /api/campaigns/[id]/invites/[inviteId]

**Files:**
- Create: `src/app/api/campaigns/[id]/invites/[inviteId]/route.ts`
- Modify: `tests/api/multiplayer.test.ts` (append)

- [ ] **Step 1: Append failing test**

```typescript
import { DELETE as deleteInvite } from '@/app/api/campaigns/[id]/invites/[inviteId]/route';

describe('DELETE /api/campaigns/[id]/invites/[inviteId]', () => {
  it('host revokes an invite', async () => {
    CURRENT_USER = HOST;
    // Create one
    const createRes = await postInvite(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    // Delete it
    const res = await deleteInvite(
      new Request('http://t', { method: 'DELETE' }) as any,
      { params: Promise.resolve({ id: campaignId, inviteId: invite.id }) },
    );
    expect(res.status).toBe(204);
  });

  it('guest gets 403', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    CURRENT_USER = GUEST;
    const res = await deleteInvite(
      new Request('http://t', { method: 'DELETE' }) as any,
      { params: Promise.resolve({ id: campaignId, inviteId: invite.id }) },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/app/api/campaigns/[id]/invites/[inviteId]/route.ts
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

  const ok = await revokeInvite(inviteId);
  if (!ok) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 3: Run tests, expect pass**

Run: `pnpm vitest run tests/api/multiplayer.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/campaigns/[id]/invites/[inviteId]/route.ts tests/api/multiplayer.test.ts
git commit -m "feat(api): DELETE /api/campaigns/[id]/invites/[inviteId]"
```

---

### Task 12: GET /api/r/[token]

**Files:**
- Create: `src/app/api/r/[token]/route.ts`
- Modify: `tests/api/multiplayer.test.ts` (append)

- [ ] **Step 1: Append failing test**

```typescript
import { GET as resolveToken } from '@/app/api/r/[token]/route';

describe('GET /api/r/[token]', () => {
  it('valid token returns campaign info', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    const res = await resolveToken(
      new Request('http://t') as any,
      { params: Promise.resolve({ token: invite.token }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaignId).toBe(campaignId);
    expect(body.campaignName).toBe('MP Test');
  });

  it('unknown token returns 410', async () => {
    const res = await resolveToken(
      new Request('http://t') as any,
      { params: Promise.resolve({ token: 'nonexistent_' }) },
    );
    expect(res.status).toBe(410);
  });

  it('revoked token returns 410', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();
    await deleteInvite(
      new Request('http://t', { method: 'DELETE' }) as any,
      { params: Promise.resolve({ id: campaignId, inviteId: invite.id }) },
    );
    const res = await resolveToken(
      new Request('http://t') as any,
      { params: Promise.resolve({ token: invite.token }) },
    );
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/app/api/r/[token]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, users } from '@/db/schema';
import { resolveToken } from '@/multiplayer/invites';

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const invite = await resolveToken(token);
  if (!invite) {
    return NextResponse.json({ error: 'invite-not-valid' }, { status: 410 });
  }
  const [campaign] = await db
    .select({ id: campaigns.id, name: campaigns.name, hostUserId: campaigns.userId })
    .from(campaigns)
    .where(and(eq(campaigns.id, invite.campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: 'campaign-deleted' }, { status: 410 });
  }
  const [host] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, campaign.hostUserId))
    .limit(1);
  return NextResponse.json({
    campaignId: campaign.id,
    campaignName: campaign.name,
    hostName: host?.displayName ?? 'Unknown host',
  });
}
```

- [ ] **Step 3: Run tests, expect pass**

Run: `pnpm vitest run tests/api/multiplayer.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/r/[token]/route.ts tests/api/multiplayer.test.ts
git commit -m "feat(api): GET /api/r/[token] resolve invite"
```

---

### Task 13: POST /api/campaigns/[id]/join

**Files:**
- Create: `src/app/api/campaigns/[id]/join/route.ts`
- Modify: `tests/api/multiplayer.test.ts` (append)

- [ ] **Step 1: Append failing tests**

```typescript
import { POST as joinCampaign } from '@/app/api/campaigns/[id]/join/route';
import { characters } from '@/db/schema';

describe('POST /api/campaigns/[id]/join', () => {
  let guestTemplateId: string;
  beforeAll(async () => {
    const [tpl] = await db.insert(characters).values({
      userId: GUEST, name: 'Lyra',
      raceSlug: 'tiefling', classSlug: 'cleric', backgroundSlug: 'acolyte',
      classes: [{ slug: 'cleric', level: 1 }],
      abilities: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 16, CHA: 14 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 10, ac: 14, speed: 30, hitDieSize: 8, hitDiceMax: 1,
      proficiencies: { saves: ['WIS','CHA'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [],
      identity: { alignment: 'N' },
    }).returning();
    guestTemplateId = tpl!.id;
  });

  it('guest joins via valid token', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();

    CURRENT_USER = GUEST;
    const res = await joinCampaign(
      new Request('http://t', {
        method: 'POST',
        body: JSON.stringify({ token: invite.token, characterTemplateId: guestTemplateId }),
      }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
  });

  it('joining twice returns 409', async () => {
    CURRENT_USER = HOST;
    const createRes = await postInvite(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    const { invite } = await createRes.json();

    CURRENT_USER = GUEST;
    const res = await joinCampaign(
      new Request('http://t', {
        method: 'POST',
        body: JSON.stringify({ token: invite.token, characterTemplateId: guestTemplateId }),
      }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    expect(res.status).toBe(409);
  });

  it('rejects invalid token with 410', async () => {
    CURRENT_USER = GUEST;
    const res = await joinCampaign(
      new Request('http://t', {
        method: 'POST',
        body: JSON.stringify({ token: 'nonexistent_', characterTemplateId: guestTemplateId }),
      }) as any,
      { params: Promise.resolve({ id: campaignId }) },
    );
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/app/api/campaigns/[id]/join/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, isNotNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters, sessions } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { resolveToken, incrementInviteUses } from '@/multiplayer/invites';
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

  const invite = await resolveToken(body.token);
  if (!invite || invite.campaignId !== campaignId) {
    return NextResponse.json({ error: 'invite-not-valid' }, { status: 410 });
  }

  // Already in party?
  const [existing] = await db.select({ id: characters.id }).from(characters).where(and(
    eq(characters.campaignId, campaignId),
    eq(characters.userId, userId),
    isNotNull(characters.templateId),
    isNull(characters.deletedAt),
  )).limit(1);
  if (existing) {
    // Find their active session
    const [session] = await db.select({ id: sessions.id }).from(sessions).where(and(
      eq(sessions.campaignId, campaignId),
      isNull(sessions.deletedAt),
    )).orderBy(desc(sessions.updatedAt)).limit(1);
    return NextResponse.json({ error: 'already-in-party', sessionId: session?.id }, { status: 409 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Verify the template exists and is a template
      const [tpl] = await tx.select().from(characters).where(and(
        eq(characters.id, body.characterTemplateId),
        isNull(characters.deletedAt),
      )).limit(1);
      if (!tpl) throw new Error('character-not-found');
      if (tpl.userId !== userId) throw new Error('character-forbidden');
      if (tpl.templateId !== null) throw new Error('not-a-template');

      // Fork the template
      await forkTemplateForCampaign({
        tx,
        userId,
        characterId: body.characterTemplateId,
        campaignId,
      });

      // Increment invite uses
      await incrementInviteUses(invite.id);

      // Resolve active session
      const [session] = await tx.select({ id: sessions.id }).from(sessions).where(and(
        eq(sessions.campaignId, campaignId),
        isNull(sessions.deletedAt),
      )).orderBy(desc(sessions.updatedAt)).limit(1);

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
```

- [ ] **Step 3: Run tests, expect pass**

Run: `pnpm vitest run tests/api/multiplayer.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/campaigns/[id]/join/route.ts tests/api/multiplayer.test.ts
git commit -m "feat(api): POST /api/campaigns/[id]/join"
```

---

## Phase 4 — Master loop + real-time

### Task 14: Snapshot builder returns party

**Files:**
- Modify: `src/sessions/snapshot.ts`
- Modify: `tests/sessions/snapshot.test.ts` (extend)

- [ ] **Step 1: Update buildSnapshot signature + implementation**

Open `src/sessions/snapshot.ts`. The current `buildSnapshot(sessionId, userId)` returns `{ session, campaign, state, character }`. Modify it to also include a `party` array, `currentPlayerCharacterId`, and `viewerCharacterId`:

```typescript
// Add after the existing single-character query:
const partyRows = await db
  .select()
  .from(characters)
  .where(and(
    eq(characters.campaignId, row.session.campaignId!),
    isNull(characters.deletedAt),
    isNotNull(characters.templateId),
  ))
  .orderBy(characters.createdAt);

const viewerChar = partyRows.find((c) => c.userId === userId) ?? null;

return {
  session: row.session,
  campaign: row.campaign,
  state: row.state,
  character: viewerChar ?? row.character, // backward compat: still expose `character`
  party: partyRows,
  currentPlayerCharacterId: row.session.currentPlayerCharacterId,
  viewerCharacterId: viewerChar?.id ?? null,
};
```

The signature is now backward-compatible (existing consumers reading `.character` still work) and adds `party`, `currentPlayerCharacterId`, `viewerCharacterId`.

- [ ] **Step 2: Update the snapshot test to assert new fields**

In `tests/sessions/snapshot.test.ts`, add to one happy-path case:

```typescript
expect(snap.party).toBeInstanceOf(Array);
expect(snap.party.length).toBeGreaterThanOrEqual(1);
expect(snap.currentPlayerCharacterId).toBeDefined();
expect(snap.viewerCharacterId).toBeDefined();
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm typecheck && pnpm vitest run tests/sessions/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/sessions/snapshot.ts tests/sessions/snapshot.test.ts
git commit -m "feat(snapshot): include party + currentPlayer + viewer character"
```

---

### Task 15: Master tool `set_current_player`

**Files:**
- Modify: `src/sessions/applicator.ts` (or wherever tool handlers live — grep for `set_tonal_frame` to find the location)
- Modify: `src/ai/master/system-prompt.ts` (or wherever the tools array is exported)

- [ ] **Step 1: Locate the existing tool registry**

Run: `grep -rn "set_tonal_frame\|setTonalFrame" src/ai/ src/sessions/`

The hot spots will be: a tools array (exported to Claude) and a handler dispatch (server-side execution).

- [ ] **Step 2: Add the tool definition**

Wherever the tools array is defined, add:

```typescript
{
  name: 'set_current_player',
  description: 'Sets which character takes the next turn. Call at the end of each narrative beat to address the next player. The character must be in the party.',
  input_schema: {
    type: 'object',
    required: ['characterId'],
    properties: {
      characterId: { type: 'string', description: 'uuid of the next character to act' },
    },
  },
}
```

- [ ] **Step 3: Implement the handler**

In the applicator (or wherever `set_tonal_frame` handler lives), add the case:

```typescript
case 'set_current_player': {
  const { characterId } = toolInput as { characterId: string };
  const [valid] = await tx
    .select({ id: characters.id })
    .from(characters)
    .innerJoin(sessions, eq(sessions.campaignId, characters.campaignId))
    .where(and(
      eq(sessions.id, ctx.sessionId),
      eq(characters.id, characterId),
      isNull(characters.deletedAt),
      isNotNull(characters.templateId),
    ))
    .limit(1);
  if (!valid) return { error: 'character-not-in-party' };

  await tx
    .update(sessions)
    .set({ currentPlayerCharacterId: characterId, turnsSinceMasterAdvance: 0 })
    .where(eq(sessions.id, ctx.sessionId));

  await notifySession(ctx.sessionId, { type: 'turn-change', characterId });
  return { ok: true, currentPlayerCharacterId: characterId };
}
```

Add `import { notifySession } from '@/sessions/notify';` at the top.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(master): set_current_player tool + handler"
```

---

### Task 16: System prompt PARTY MODE block

**Files:**
- Modify: `src/ai/master/system-prompt.ts`

- [ ] **Step 1: Find the right insertion point**

Open `src/ai/master/system-prompt.ts`. Find where `tonalFrame` is described in the prompt, or where the system prompt builder assembles its sections. Insert the PARTY MODE block where the character description currently lives.

- [ ] **Step 2: Add the PARTY MODE block**

Add a helper that builds the party-mode section:

```typescript
function buildPartyModeBlock(
  party: Array<{ id: string; name: string; raceSlug: string; classSlug: string; level: number }>,
  currentPlayerCharacterId: string | null,
): string {
  const list = party.map((c) => `- ${c.name} (${c.raceSlug} ${c.classSlug} L${c.level}, id: ${c.id})`).join('\n');
  const currentName = party.find((c) => c.id === currentPlayerCharacterId)?.name ?? '(unset)';
  return [
    `PARTY MODE: This campaign has a party of ${party.length} characters:`,
    list,
    '',
    `Address players by their character name (e.g., "Tharion, you see..."). Never use "you" to refer to multiple players ambiguously. The character currently acting is ${currentName}.`,
    '',
    `AT END OF EACH NARRATIVE BEAT, call the tool set_current_player with the characterId of the next player to act. Pick based on narrative tension, party initiative, or round-robin as feels natural. If you do not call set_current_player for 3 consecutive turns, the system will auto-advance round-robin to prevent deadlock.`,
  ].join('\n');
}
```

Call this from the system-prompt builder, passing `snapshot.party` and `snapshot.currentPlayerCharacterId`. Insert the result in the appropriate position (typically right before the per-character snapshot block).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ai/master/system-prompt.ts
git commit -m "feat(master): PARTY MODE block in system prompt"
```

---

### Task 17: Post-loop fallback round-robin

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Add the post-loop hook**

After the master loop completes (success or graceful end), before the route's final response, add:

```typescript
import { nextInParty } from '@/multiplayer/party';

// Inside the route, after the master loop finishes:
await db.transaction(async (tx) => {
  const [s] = await tx
    .select({
      tsma: sessions.turnsSinceMasterAdvance,
      cpcId: sessions.currentPlayerCharacterId,
      campaignId: sessions.campaignId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!s) return;

  if (s.tsma === 0) {
    // Master called set_current_player. Just bump turn_seq.
  } else {
    const next = s.tsma + 1;
    if (next >= 3) {
      const party = await tx
        .select({ id: characters.id, createdAt: characters.createdAt })
        .from(characters)
        .where(and(
          eq(characters.campaignId, s.campaignId!),
          isNull(characters.deletedAt),
          isNotNull(characters.templateId),
        ))
        .orderBy(characters.createdAt);
      const nextChar = nextInParty(s.cpcId ?? '', party);
      await tx
        .update(sessions)
        .set({ currentPlayerCharacterId: nextChar.id, turnsSinceMasterAdvance: 0 })
        .where(eq(sessions.id, sessionId));
      await notifySession(sessionId, { type: 'turn-change', characterId: nextChar.id });
    } else {
      await tx
        .update(sessions)
        .set({ turnsSinceMasterAdvance: next })
        .where(eq(sessions.id, sessionId));
    }
  }

  await tx.update(sessions).set({ turnSeq: sql`turn_seq + 1` }).where(eq(sessions.id, sessionId));
});
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/turn/route.ts
git commit -m "feat(master): post-loop fallback round-robin"
```

---

### Task 18: Permission check on POST /turn

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Add the ownership check**

At the top of the POST handler, after auth + session lookup, add:

```typescript
const [check] = await db
  .select({
    cpcId: sessions.currentPlayerCharacterId,
    ownerUserId: characters.userId,
  })
  .from(sessions)
  .innerJoin(characters, eq(characters.id, sessions.currentPlayerCharacterId))
  .where(eq(sessions.id, sessionId))
  .limit(1);
if (!check) return NextResponse.json({ error: 'session-not-found' }, { status: 404 });
if (check.ownerUserId !== userId) {
  return NextResponse.json({ error: 'not-your-turn', currentCharacterId: check.cpcId }, { status: 403 });
}
```

Place this BEFORE the existing turn-lock acquisition logic.

- [ ] **Step 2: Run typecheck + sessions tests**

Run: `pnpm typecheck && pnpm vitest run tests/api/sessions.test.ts`
Expected: PASS (sessions.test.ts already passes — this should not regress).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/turn/route.ts
git commit -m "feat(api): POST /turn rejects non-current-player with 403"
```

---

### Task 19: GET /api/sessions/[id] includes party

**Files:**
- Modify: `src/app/api/sessions/[id]/route.ts`

- [ ] **Step 1: Extend the response**

In the GET handler, after the session/campaign/character query, add a party query:

```typescript
const party = await db
  .select()
  .from(characters)
  .where(and(
    eq(characters.campaignId, row.session.campaignId!),
    isNull(characters.deletedAt),
    isNotNull(characters.templateId),
  ))
  .orderBy(characters.createdAt);

return NextResponse.json({
  session: row.session,
  campaign: row.campaign,
  state: row.state,
  character: row.character,
  party,
});
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/route.ts
git commit -m "feat(api): GET /api/sessions/[id] returns party"
```

---

## Phase 5 — Real-time SSE

### Task 20: GET /api/sessions/[id]/stream

**Files:**
- Create: `src/app/api/sessions/[id]/stream/route.ts`
- Create: `tests/api/sessions-stream.test.ts`

- [ ] **Step 1: Write failing test (smoke)**

```typescript
// tests/api/sessions-stream.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GET as streamRoute } from '@/app/api/sessions/[id]/stream/route';
import { db, pool } from '@/db/client';
import { users, campaigns, characters, sessions, sessionState } from '@/db/schema';

const HOST = 'user_stream_test_001';
let CURRENT_USER = HOST;

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: CURRENT_USER }),
}));

let sessionId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: HOST, displayName: 'Host' }).onConflictDoNothing();
  const [c] = await db.insert(campaigns).values({
    userId: HOST, name: 'Stream Test', premise: 'p',
  }).returning();
  const [tpl] = await db.insert(characters).values({
    userId: HOST, name: 'T',
    raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
    templateId: null, campaignId: null,
  }).returning();
  const [inst] = await db.insert(characters).values({
    userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
    classes: [{ slug: 'fighter', level: 1 }],
    abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
    proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { alignment: 'N' },
    templateId: tpl!.id, campaignId: c!.id,
  }).returning();
  const [s] = await db.insert(sessions).values({
    userId: HOST, characterId: inst!.id, campaignId: c!.id, premise: 'p',
    currentPlayerCharacterId: inst!.id,
  }).returning();
  await db.insert(sessionState).values({ sessionId: s!.id, hpCurrent: 12, hitDiceRemaining: 1 });
  sessionId = s!.id;
});

afterAll(async () => {
  await db.execute(`DELETE FROM users WHERE id = '${HOST}'`);
  await pool.end();
});

describe('GET /api/sessions/[id]/stream', () => {
  it('unauthenticated returns 401', async () => {
    CURRENT_USER = '';  // empty triggers unauth
    const req = new Request('http://t');
    const res = await streamRoute(req as any, { params: Promise.resolve({ id: sessionId }) });
    // Test mock returns userId='' which our route treats as falsy
    expect([401, 403]).toContain(res.status);
  });

  it('non-party user returns 403', async () => {
    CURRENT_USER = 'someone-else';
    const req = new Request('http://t');
    const res = await streamRoute(req as any, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(403);
  });

  // Note: testing the actual SSE stream content requires reading the
  // response body which is a ReadableStream. Smoke test only checks status.
  it('party member returns 200 with text/event-stream', async () => {
    CURRENT_USER = HOST;
    const req = new Request('http://t', { signal: AbortSignal.timeout(100) });
    const res = await streamRoute(req as any, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/app/api/sessions/[id]/stream/route.ts
import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/db/client';
import { buildSnapshot } from '@/sessions/snapshot';
import { checkPartyAccess } from '@/multiplayer/access';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthorized', { status: 401 });
  const { id: sessionId } = await ctx.params;

  const access = await checkPartyAccess(userId, sessionId);
  if (!access) return new Response('forbidden', { status: 403 });

  const client = await pool.connect();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const snapshot = await buildSnapshot(sessionId, userId);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', snapshot })}\n\n`));
      } catch (e) {
        console.error('snapshot failed:', e);
      }

      await client.query(`LISTEN "session_${sessionId}"`);
      client.on('notification', (msg) => {
        if (msg.payload) {
          controller.enqueue(encoder.encode(`data: ${msg.payload}\n\n`));
        }
      });

      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keep-alive\n\n`)); } catch {}
      }, 25_000);

      req.signal.addEventListener('abort', async () => {
        clearInterval(ka);
        try { await client.query(`UNLISTEN "session_${sessionId}"`); } catch {}
        client.release();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}
```

- [ ] **Step 3: Run tests, expect pass**

Run: `pnpm vitest run tests/api/sessions-stream.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/stream/route.ts tests/api/sessions-stream.test.ts
git commit -m "feat(api): GET /api/sessions/[id]/stream SSE endpoint"
```

---

### Task 21: Wire notifySession into existing writers

**Files:**
- Modify: `src/sessions/applicator.ts`

- [ ] **Step 1: Add notify calls after each mutation**

Open `src/sessions/applicator.ts`. After each mutation that affects state visible to other clients, add a `notifySession` call. Specifically:

- After `session_state` UPDATE (HP, conditions, slots, combat state changes): `await notifySession(sessionId, { type: 'state' });`
- After `dice_log` INSERT: `await notifySession(sessionId, { type: 'dice', logId: row.id });`
- After `session_messages` INSERT (player message persistence): `await notifySession(sessionId, { type: 'message', messageId: row.id });`

Add `import { notifySession } from '@/sessions/notify';` at the top.

For master message streaming (chunks), see Task 22.

- [ ] **Step 2: Run typecheck + applicator tests**

Run: `pnpm typecheck && pnpm vitest run tests/sessions/applicator.test.ts`
Expected: PASS (applicator tests still pass — notify is non-blocking).

- [ ] **Step 3: Commit**

```bash
git add src/sessions/applicator.ts
git commit -m "feat(sessions): notify subscribers on state, dice, message mutations"
```

---

### Task 22: Master chunk streaming via notifySession

**Files:**
- Modify: the master loop chunk handler (search via `grep -rn "ContentBlockDelta\|content_block_delta\|streaming" src/ai/`)

- [ ] **Step 1: Locate the streaming code path**

The Claude SDK fires `content_block_delta` events for streaming text. The current code likely accumulates these into the response stream. Find that code.

- [ ] **Step 2: NOTIFY each chunk in addition to existing SSE writes**

Wherever a text chunk is appended to the master response, call:

```typescript
await notifySession(sessionId, { type: 'message-chunk', messageId, text: chunkText });
```

`messageId` is a stable id for the current master message-in-progress — assigned at the beginning of the turn (when the master response row is INSERT'd into session_messages, even if as a placeholder with empty content). If the existing code only INSERTs at the END of the turn, change it to INSERT at the beginning with an empty content, then UPDATE with the final text + emit `{type:'message', messageId}` at the end.

This may require a small refactor of the master loop's message persistence. If too invasive, simpler interim: emit `{type:'message-chunk', text}` without a messageId (clients accumulate text without correlation), and emit `{type:'message'}` at the end without a specific id (clients refetch the snapshot to get the final message).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(master): broadcast chunks via notifySession"
```

---

### Task 23: POST /turn becomes fire-and-forget

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Replace the SSE response with 202**

In the POST handler, after the master loop completes (and after the post-loop hook from Task 17), replace the existing SSE response with a JSON 202:

```typescript
// Instead of returning an SSE Response, return 202 Accepted on success
return NextResponse.json({ ok: true, turnSeq: /* current turnSeq */ }, { status: 202 });
```

The master chunks are already broadcast via notifySession (Task 22), so clients see the response via their unified SSE stream.

The existing client hook `use-turn-stream.ts` becomes obsolete after this — Task 25 removes it.

- [ ] **Step 2: Run typecheck + sessions tests**

Run: `pnpm typecheck && pnpm vitest run tests/api/sessions.test.ts tests/sessions/use-turn-stream.test.ts`
Expected: typecheck PASS; sessions.test.ts PASS; use-turn-stream.test.ts may FAIL (will be removed in Task 25). If it fails, comment out the relevant assertions for now — Task 25 deletes the file.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/turn/route.ts
git commit -m "refactor(api): POST /turn returns 202; chunks flow via /stream"
```

---

## Phase 6 — UI

### Task 24: useSessionStream hook

**Files:**
- Create: `src/sessions/use-session-stream.ts`
- Delete: `src/sessions/use-session-state.ts`
- Delete: `src/sessions/use-turn-stream.ts`
- Modify: any consumer that imported the deleted hooks

- [ ] **Step 1: Find consumers**

Run: `grep -rn "use-session-state\|useSessionState\|use-turn-stream\|useTurnStream" src/`

Note the call sites; they'll need to be updated in Task 26.

- [ ] **Step 2: Create the new unified hook**

```typescript
// src/sessions/use-session-stream.ts
'use client';

import { useEffect, useState, useCallback } from 'react';

export type SessionSnapshot = {
  session: any;
  campaign: any;
  state: any;
  character: any;
  party: any[];
  currentPlayerCharacterId: string | null;
  viewerCharacterId: string | null;
};

export type StreamingMessage = { text: string; messageId?: string } | null;

export function useSessionStream(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (res.ok) setSnapshot(await res.json());
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      switch (ev.type) {
        case 'snapshot':
          setSnapshot(ev.snapshot);
          setError(null);
          break;
        case 'message-chunk':
          setStreamingMessage((prev) => ({
            text: (prev?.text ?? '') + ev.text,
            messageId: ev.messageId,
          }));
          break;
        case 'message':
          setStreamingMessage(null);
          refetch();
          break;
        case 'state':
        case 'dice':
          refetch();
          break;
        case 'turn-change':
          setSnapshot((s) => (s ? { ...s, currentPlayerCharacterId: ev.characterId } : s));
          break;
      }
    };
    es.onerror = () => setError('connection_lost');
    return () => es.close();
  }, [sessionId, refetch]);

  return { snapshot, streamingMessage, error, refetch };
}
```

- [ ] **Step 3: Delete the old hooks**

```bash
git rm src/sessions/use-session-state.ts src/sessions/use-turn-stream.ts
```

- [ ] **Step 4: Run typecheck (expect failures in consumers — fixed in Task 26)**

Run: `pnpm typecheck 2>&1 | head -20`
Note the consumer files reporting "Cannot find module" — those are Task 26's work.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/use-session-stream.ts
git commit -m "feat(sessions): use-session-stream unified hook (removes use-session-state + use-turn-stream)"
```

---

### Task 25: Game screen — party strip + composer gating

**Files:**
- Create: `src/components/sessions/party-strip.tsx`
- Modify: `src/app/(authed)/sessions/[id]/page.tsx`
- Modify: `src/app/(authed)/sessions/[id]/game-client.tsx`

- [ ] **Step 1: Create PartyStrip component**

```tsx
// src/components/sessions/party-strip.tsx
'use client';

import { Chip } from '@/components/ui/chip';

export type PartyStripProps = {
  party: Array<{ id: string; name: string; raceSlug: string; classSlug: string; level: number }>;
  currentPlayerCharacterId: string | null;
  viewerCharacterId: string | null;
};

export function PartyStrip({ party, currentPlayerCharacterId, viewerCharacterId }: PartyStripProps) {
  return (
    <div style={{
      display: 'flex', gap: 8, padding: '8px 12px',
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 8, marginBottom: 12,
      alignItems: 'center', overflowX: 'auto',
    }}>
      <span style={{ fontSize: 11, color: 'var(--fg-subtle)', letterSpacing: 1, textTransform: 'uppercase', marginRight: 4 }}>
        Party
      </span>
      {party.map((p) => {
        const isActive = p.id === currentPlayerCharacterId;
        const isMe = p.id === viewerCharacterId;
        return (
          <div key={p.id} style={{
            padding: '4px 10px', borderRadius: 16,
            background: isActive ? 'var(--accent)' : 'transparent',
            border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
            color: isActive ? '#000' : 'var(--fg)',
            fontSize: 12, whiteSpace: 'nowrap',
            fontWeight: isMe ? 600 : 400,
          }}>
            {isActive && <span style={{ marginRight: 4 }}>●</span>}
            {p.name}{isMe ? ' (you)' : ''}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Update page.tsx to use the new hook**

Open `src/app/(authed)/sessions/[id]/page.tsx`. Replace any `useSessionState`/`useTurnStream` imports with `useSessionStream`. Pass `snapshot` to GameClient.

- [ ] **Step 3: Update GameClient to gate composer + render PartyStrip**

In `src/app/(authed)/sessions/[id]/game-client.tsx`:

```tsx
import { PartyStrip } from '@/components/sessions/party-strip';

// Inside the component:
const isMyTurn = snapshot?.viewerCharacterId === snapshot?.currentPlayerCharacterId;
const currentPlayerName = snapshot?.party.find(p => p.id === snapshot?.currentPlayerCharacterId)?.name ?? '...';

// Above the chat log:
{snapshot && snapshot.party.length > 1 && (
  <PartyStrip
    party={snapshot.party}
    currentPlayerCharacterId={snapshot.currentPlayerCharacterId}
    viewerCharacterId={snapshot.viewerCharacterId}
  />
)}

// In the composer textarea + quick-action buttons:
<textarea
  // ...existing props
  disabled={!isMyTurn || sending}
  placeholder={isMyTurn ? 'What do you do?' : `Waiting for ${currentPlayerName}…`}
/>
<button disabled={!isMyTurn || sending}>Send</button>
// ...same disabled prop on Skill check, Attack, Dodge, Short rest, Look up rule buttons
```

The POST /turn call's response handling changes: it now returns 202; the actual master response arrives via the SSE stream's `message-chunk` and `message` events (already handled by the hook).

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sessions/party-strip.tsx src/app/(authed)/sessions/[id]/
git commit -m "feat(ui): party strip + composer gating on game screen"
```

---

### Task 26: Chat bubbles author-aware

**Files:**
- Modify: `src/app/(authed)/sessions/[id]/game-client.tsx` (or wherever messages render)

- [ ] **Step 1: Update the message renderer**

Find the bubble rendering code. For each `session_messages` row:
- If `role === 'master'`: prefix `The Master:` (or use existing master-styled bubble)
- If `role === 'system'`: prefix `System:` (or use existing system styling)
- If `role === 'player'` and `authorCharacterId` set: prefix `{characterName}:` where `characterName = party.find(p => p.id === authorCharacterId)?.name`
- If `role === 'player'` and `authorCharacterId === null` (legacy): prefix `Player:` or no prefix (graceful fallback)

```tsx
function authorLabel(msg: SessionMessage, party: Party): string {
  if (msg.role === 'master') return 'The Master';
  if (msg.role === 'system') return 'System';
  const char = party.find((p) => p.id === msg.authorCharacterId);
  return char?.name ?? 'Player';
}
```

Render: `<strong>{authorLabel(msg, party)}:</strong> {msg.content}`.

- [ ] **Step 2: Update server-side player message insert to set authorCharacterId**

In `src/app/api/sessions/[id]/turn/route.ts` (or wherever the player message is persisted at turn start), the insert into `session_messages` for `role: 'player'` must include `authorCharacterId`. The value is `sessions.current_player_character_id` — the same character whose owner is allowed to take this turn (enforced by Task 18's permission check). Modify the insert call:

```typescript
// Before (or equivalent):
await db.insert(sessionMessages).values({
  sessionId,
  role: 'player',
  content: playerMessageText,
});

// After:
await db.insert(sessionMessages).values({
  sessionId,
  role: 'player',
  content: playerMessageText,
  authorCharacterId: session.currentPlayerCharacterId, // session was loaded at the top of the route
});
```

For `role: 'master'` and `role: 'system'` inserts (elsewhere in the master loop): leave `authorCharacterId` unset (NULL).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ui): chat bubbles show author character name"
```

---

### Task 27: Character wizard `returnTo` support

**Files:**
- Modify: `src/app/(authed)/characters/new/wizard-client.tsx`

- [ ] **Step 1: Read query param and use on save**

In the wizard client component, add:

```typescript
import { useSearchParams, useRouter } from 'next/navigation';

const search = useSearchParams();
const returnTo = search.get('returnTo');
const router = useRouter();

// In the save handler, after successful create:
if (returnTo) {
  router.push(returnTo);
} else {
  router.push('/hub');
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/(authed)/characters/new/wizard-client.tsx
git commit -m "feat(ui): wizard supports ?returnTo query param"
```

---

### Task 28: /r/[token] resolve page

**Files:**
- Create: `src/app/(authed)/r/[token]/page.tsx`
- Create: `src/components/multiplayer/expired-invite-card.tsx`

- [ ] **Step 1: Implement the expired card**

```tsx
// src/components/multiplayer/expired-invite-card.tsx
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function ExpiredInviteCard() {
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px' }}>
      <Card>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Invite link expired</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
          This invite link is no longer valid (expired, revoked, or fully used). Ask the host for a new link.
        </p>
        <Link href="/hub"><Button variant="primary" size="md">Back to hub</Button></Link>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Implement the resolve page**

```tsx
// src/app/(authed)/r/[token]/page.tsx
import { redirect } from 'next/navigation';
import { resolveToken } from '@/multiplayer/invites';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns } from '@/db/schema';
import { ExpiredInviteCard } from '@/components/multiplayer/expired-invite-card';

export const dynamic = 'force-dynamic';

export default async function ResolveInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await resolveToken(token);
  if (!invite) return <ExpiredInviteCard />;
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(eq(campaigns.id, invite.campaignId), isNull(campaigns.deletedAt))).limit(1);
  if (!campaign) return <ExpiredInviteCard />;
  redirect(`/campaigns/${campaign.id}/join?token=${token}`);
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/(authed)/r/ src/components/multiplayer/
git commit -m "feat(ui): /r/[token] resolve page"
```

---

### Task 29: /campaigns/[id]/join page

**Files:**
- Create: `src/app/(authed)/campaigns/[id]/join/page.tsx`
- Create: `src/app/(authed)/campaigns/[id]/join/join-client.tsx`

- [ ] **Step 1: Server component**

```tsx
// src/app/(authed)/campaigns/[id]/join/page.tsx
import { auth } from '@clerk/nextjs/server';
import { redirect, notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters } from '@/db/schema';
import { resolveToken } from '@/multiplayer/invites';
import { JoinClient } from './join-client';
import { ExpiredInviteCard } from '@/components/multiplayer/expired-invite-card';

export const dynamic = 'force-dynamic';

export default async function JoinCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) {
    const sp = await searchParams;
    const here = `/campaigns/${(await params).id}/join${sp.token ? `?token=${sp.token}` : ''}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }
  const { id: campaignId } = await params;
  const { token } = await searchParams;

  if (!token) notFound();

  const invite = await resolveToken(token);
  if (!invite || invite.campaignId !== campaignId) return <ExpiredInviteCard />;

  const [campaign] = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))).limit(1);
  if (!campaign) return <ExpiredInviteCard />;

  const templates = await db.select().from(characters).where(and(
    eq(characters.userId, userId),
    isNull(characters.templateId),
    isNull(characters.deletedAt),
  ));

  if (templates.length === 0) {
    redirect(`/characters/new?returnTo=${encodeURIComponent(`/campaigns/${campaignId}/join?token=${token}`)}`);
  }

  return (
    <JoinClient
      campaignId={campaignId}
      campaignName={campaign.name}
      token={token}
      templates={templates.map((t) => ({
        id: t.id, name: t.name, raceSlug: t.raceSlug, classSlug: t.classSlug, level: t.level,
      }))}
    />
  );
}
```

- [ ] **Step 2: Client component**

```tsx
// src/app/(authed)/campaigns/[id]/join/join-client.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Template = { id: string; name: string; raceSlug: string; classSlug: string; level: number };

export function JoinClient({
  campaignId, campaignName, token, templates,
}: {
  campaignId: string;
  campaignName: string;
  token: string;
  templates: Template[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>(templates[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onJoin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, characterTemplateId: selectedId }),
      });
      if (res.status === 409) {
        const body = await res.json();
        if (body.sessionId) {
          router.push(`/sessions/${body.sessionId}`);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { sessionId } = await res.json();
      router.push(`/sessions/${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 880, margin: '40px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Join {campaignName}</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4 }}>Pick the character you want to play.</p>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 12, marginTop: 24,
      }}>
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedId(t.id)}
            style={{
              textAlign: 'left', padding: 14, borderRadius: 8,
              background: 'var(--bg-card)',
              border: selectedId === t.id ? '2px solid var(--accent)' : '1px solid var(--border)',
              cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
            }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>{t.name}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{t.raceSlug} · {t.classSlug} · L{t.level}</div>
          </button>
        ))}
      </div>

      {error && (
        <Card style={{ marginTop: 16, borderColor: 'var(--danger)' }}>
          <div style={{ color: 'var(--danger)' }}>Error: {error}</div>
        </Card>
      )}

      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          size="md"
          icon="sparkle"
          onClick={onJoin}
          disabled={!selectedId || submitting}
        >
          {submitting ? 'Joining…' : `Join as ${templates.find(t => t.id === selectedId)?.name}`}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/(authed)/campaigns/[id]/join/
git commit -m "feat(ui): /campaigns/[id]/join page (server+client)"
```

---

### Task 30: Campaign detail — invite section (host) + party list

**Files:**
- Create: `src/components/campaigns/invite-section.tsx`
- Modify: `src/app/(authed)/campaigns/[id]/page.tsx`

- [ ] **Step 1: Create InviteSection client component**

```tsx
// src/components/campaigns/invite-section.tsx
'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Invite = {
  id: string;
  token: string;
  expiresAt: string | null;
  maxUses: number | null;
  usesCount: number;
};

export function InviteSection({ campaignId, initial }: { campaignId: string; initial: { invites: Invite[] } }) {
  const [invites, setInvites] = useState<Invite[]>(initial.invites);
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const onGenerate = async () => {
    setBusy(true);
    const res = await fetch(`/api/campaigns/${campaignId}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const { invite } = await res.json();
      setInvites((prev) => [invite, ...prev]);
    }
    setBusy(false);
  };

  const onRevoke = async (id: string) => {
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/invites/${id}`, { method: 'DELETE' });
    setInvites((prev) => prev.filter((i) => i.id !== id));
    setBusy(false);
  };

  const onCopy = (token: string) => {
    navigator.clipboard.writeText(`${origin}/r/${token}`);
  };

  if (invites.length === 0) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
              Invite link
            </div>
            <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 4 }}>
              No active invite. Generate one to invite friends.
            </div>
          </div>
          <Button variant="primary" size="md" onClick={onGenerate} disabled={busy}>
            Generate invite link
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {invites.map((inv) => (
        <Card key={inv.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
                Invite link
              </div>
              <code style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 13, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {origin}/r/{inv.token}
              </code>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
                {inv.expiresAt ? `Expires ${new Date(inv.expiresAt).toLocaleString()} · ` : 'No expiry · '}
                {inv.maxUses !== null ? `${inv.usesCount}/${inv.maxUses} uses` : `${inv.usesCount} uses`}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => onCopy(inv.token)}>Copy</Button>
            <Button variant="ghost" size="sm" onClick={() => onRevoke(inv.id)} disabled={busy}>Revoke</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Server component fetches invites + party**

Modify `src/app/(authed)/campaigns/[id]/page.tsx`. After the existing `getCampaign` call:

```tsx
import { listActiveInvites } from '@/multiplayer/invites';
import { InviteSection } from '@/components/campaigns/invite-section';

// Inside the component, after data fetch:
const isHost = userId === campaign.userId;
const invites = isHost ? await listActiveInvites(campaignId) : [];

const party = await db.select().from(characters).where(and(
  eq(characters.campaignId, campaignId),
  isNotNull(characters.templateId),
  isNull(characters.deletedAt),
)).orderBy(characters.createdAt);

// In the JSX, between the header and the existing hero card:
{isHost && (
  <div style={{ marginTop: 18, marginBottom: 18 }}>
    <InviteSection campaignId={campaignId} initial={{ invites }} />
  </div>
)}

// Replace the existing single hero card with:
<div style={{ marginTop: 18 }}>
  <div style={{ fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
    Party ({party.length})
  </div>
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
    {party.map((p) => (
      <Card key={p.id} style={{ padding: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {p.name}{p.userId === userId && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}> (you)</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.raceSlug} · {p.classSlug} · L{p.level}</div>
      </Card>
    ))}
  </div>
</div>
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/campaigns/invite-section.tsx src/app/(authed)/campaigns/[id]/page.tsx
git commit -m "feat(ui): campaign detail invite section + party list"
```

---

## Phase 7 — Test fixtures + E2E

### Task 31: Update test fixtures inserting player messages

**Files:**
- Modify: any test file inserting `session_messages` with `role='player'` directly via DB

- [ ] **Step 1: Locate affected fixtures**

Run: `grep -rln "role.*'player'\|role:.*'player'" tests/ | xargs grep -l "session_messages\|sessionMessages"`

For each, check if the insert builder includes `authorCharacterId`. Add it where missing — typically the value is the `characterId` of the session being created.

- [ ] **Step 2: Run all tests**

Run: `pnpm vitest run --no-file-parallelism 2>&1 | tail -8`
Expected: same baseline as before plus the new multiplayer tests passing.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(fixtures): player session_messages include author_character_id"
```

---

### Task 32: E2E multiplayer happy path

**Files:**
- Create: `tests/e2e/multiplayer.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/multiplayer.spec.ts
import { test, expect, type Page } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

test.describe('Multiplayer remote', () => {
  test('unauthed /r/[token] redirects to sign-in', async ({ page }) => {
    await page.goto('/r/test_token_xyz');
    await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('authenticated 2-player flow', async ({ browser }) => {
    test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID and a second test user');

    // Host context
    const hostCtx = await browser.newContext({ /* host clerk token */ });
    const hostPage = await hostCtx.newPage();
    await hostPage.goto('/hub');
    await hostPage.getByRole('link', { name: /new campaign/i }).first().click();
    await hostPage.locator('button').filter({ hasText: /L\d+/ }).first().click();
    await hostPage.getByRole('button', { name: /next: premise/i }).click();
    await hostPage.getByRole('button', { name: /begin the tale/i }).click();
    await hostPage.waitForURL(/\/sessions\/[0-9a-f-]+/);
    const sessionUrl = hostPage.url();

    // Host navigates to campaign detail, generates invite
    const campaignId = sessionUrl.match(/sessions\/([0-9a-f-]+)/)?.[1];
    // Actually: navigate to /campaigns/[id] — id is the campaign id, not the session id.
    // For the e2e flow, host needs to query their hub to find the campaign.
    await hostPage.goto('/hub');
    await hostPage.locator('a[href^="/campaigns/"]').first().click();
    await hostPage.getByRole('button', { name: /generate invite link/i }).click();
    await hostPage.getByRole('button', { name: /copy/i }).click();
    const inviteUrl = await hostPage.evaluate(() => navigator.clipboard.readText());
    expect(inviteUrl).toMatch(/\/r\/[A-Za-z0-9_-]+/);

    // Guest context
    const guestCtx = await browser.newContext({ /* second clerk token */ });
    const guestPage = await guestCtx.newPage();
    await guestPage.goto(inviteUrl);
    await guestPage.waitForURL(/\/campaigns\/[0-9a-f-]+\/join/);
    // Guest must already have a template character; if not, the redirect path
    // sends them through /characters/new — handle either case here.
    if (guestPage.url().includes('/characters/new')) {
      // Fast-skip: build a basic character via the wizard.
      // (Implementer: depends on existing wizard E2E patterns; may need helper.)
      test.skip(true, 'guest needs pre-existing template — skip if not seeded');
    }
    await guestPage.locator('button').filter({ hasText: /L\d+/ }).first().click();
    await guestPage.getByRole('button', { name: /join as/i }).click();
    await guestPage.waitForURL(/\/sessions\/[0-9a-f-]+/);

    // Both should now see the game screen
    await expect(hostPage.locator('text=/Party/i').first()).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.locator('text=/Party/i').first()).toBeVisible({ timeout: 10_000 });

    // Composer enabled for one, disabled for the other
    const hostCanSend = await hostPage.getByRole('button', { name: /^send$/i }).isEnabled();
    const guestCanSend = await guestPage.getByRole('button', { name: /^send$/i }).isEnabled();
    expect(hostCanSend !== guestCanSend).toBe(true);
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `pnpm test:e2e tests/e2e/multiplayer.spec.ts`
Expected: the unauthed redirect case PASSES; the 2-player case SKIPS unless `CLERK_TESTING_TOKEN_USER_ID` is configured for two users.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/multiplayer.spec.ts
git commit -m "test(e2e): multiplayer remote happy path"
```

---

## Phase 8 — Verification

### Task 33: Final verification

**Files:** none.

- [ ] **Step 1: Run all suites sequentially**

Run: `pnpm typecheck && pnpm vitest run --no-file-parallelism`
Expected: typecheck PASS; tests show baseline (1757+ passing, 3 pre-existing failures) plus new multiplayer tests passing.

- [ ] **Step 2: Verify invariants**

```bash
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM sessions WHERE current_player_character_id IS NULL AND deleted_at IS NULL;"
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM session_messages WHERE role = 'player' AND author_character_id IS NULL;"
# Plus the 4 from campaign management §7.8:
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM sessions WHERE campaign_id IS NULL AND deleted_at IS NULL;"
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM characters WHERE template_id IS NOT NULL AND campaign_id IS NULL;"
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM characters WHERE template_id IS NULL AND campaign_id IS NOT NULL;"
docker exec dnd-ai-postgres psql -U postgres -d dnd_ai -c "SELECT COUNT(*) FROM campaigns c LEFT JOIN sessions s ON s.campaign_id = c.id WHERE s.id IS NULL;"
```

All counts should be `0`.

- [ ] **Step 3: Coverage check**

Run: `pnpm test:coverage -- src/multiplayer/`
Expected: ≥ 85% line coverage on `src/multiplayer/`.

- [ ] **Step 4: Manual smoke (optional)**

Two browser sessions: host creates campaign → generate invite → guest opens URL → guest joins → both see game screen → host sends a turn → both see master response stream.

---

### Task 34: (Follow-up PR, defer ≥1 week) — NOT NULL on current_player_character_id

**Note:** open this PR only after ≥1 week of stable production. Verifies that no race or edge case produced a NULL `current_player_character_id` on an active session.

**Files:**
- Modify: `src/db/schema/sessions.ts` — add `.notNull()` to `currentPlayerCharacterId`
- Create: auto-generated migration

- [ ] **Step 1: Tighten schema**

```typescript
currentPlayerCharacterId: uuid('current_player_character_id').notNull().references(() => characters.id),
```

- [ ] **Step 2: Generate migration**

Run: `pnpm db:generate`
Expected: new migration with `ALTER TABLE sessions ALTER COLUMN current_player_character_id SET NOT NULL`.

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm typecheck && pnpm vitest run --no-file-parallelism`
Expected: PASS. If any fixtures fail with NULL violations, update them to include `currentPlayerCharacterId`.

- [ ] **Step 4: Apply locally + commit**

```bash
pnpm db:migrate
git add -A
git commit -m "feat(db): tighten sessions.current_player_character_id to NOT NULL"
```

---

## Notes for the executor

- **Migration number**: the actual filename will be `0029_<adjective>_<noun>.sql` or higher depending on intervening migrations. Use whatever Drizzle produces.
- **Token rate limiting**: not in this slice. Add via middleware if abuse appears.
- **Player offline handling**: out of scope. Manual host intervention or 3-turn fallback covers the gap.
- **Local pass-and-play**: explicitly out of scope (slice C of #6).
- **Existing solo workflow**: must continue to work unchanged. The migration backfill (Task 4) handles legacy data; the application enforces N=1 as a special case throughout.
- **Use the existing `forkTemplateForCampaign`** from `src/campaigns/fork.ts` — do not reimplement.
- **Drizzle transaction handle**: many of the new endpoints use `db.transaction(async tx => ...)` for atomicity. Inside the tx, all schema imports work the same.
- **Tests that hit the DB**: ensure a clean cleanup in `afterAll` so the test user IDs don't pollute the local DB across runs.
