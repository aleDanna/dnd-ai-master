# Master Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the master AI's hallucinations and inconsistencies on long campaigns by adding chapter summaries + a structured codex of narrative entities, populated by an async extractor and exposed to the master via context injection and a `lookup_codex` tool.

**Architecture:** Two new tables (`session_chapters`, `codex_entities`) hold campaign memory. After every turn, `extractMemory()` runs via `waitUntil` to update the codex (light mode every turn) and produce chapter summaries (full mode every 40 messages). The master receives a hybrid context at turn time — chapter digests + scene card + codex index — and can fetch full entity records on demand via a new `lookup_codex` tool. Existing campaigns recover memory via an idempotent on-demand backfill endpoint with SSE progress.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM, Postgres (Neon serverless), Anthropic + OpenAI providers (existing `MasterProvider` interface), Vitest, Playwright, Vercel `waitUntil`.

**Reference spec:** `docs/superpowers/specs/2026-05-05-master-memory-design.md`

---

## File map (decomposition)

**New files:**
- `src/db/schema/session-chapters.ts` — drizzle schema for chapters
- `src/db/schema/codex-entities.ts` — drizzle schema for codex entities
- `src/sessions/memory/types.ts` — patch + entity types
- `src/sessions/memory/patch.ts` — `applyPatch()` deterministic upserter
- `src/sessions/memory/prompt.ts` — extractor system prompt
- `src/sessions/memory/extractor.ts` — `extractMemory()` orchestrator
- `src/sessions/memory/context.ts` — `loadMemoryContext()` + scene card selection
- `src/engine/tools/lookup-codex.ts` — db-aware tool handler
- `src/app/api/sessions/[id]/memory/status/route.ts` — GET memory status
- `src/app/api/sessions/[id]/memory/rebuild/route.ts` — POST SSE rebuild
- `src/components/memory-status-banner.tsx` — banner UI during backfill
- `tests/sessions/memory/patch.test.ts`
- `tests/sessions/memory/extractor.test.ts`
- `tests/sessions/memory/context.test.ts`
- `tests/engine/lookup-codex.test.ts`
- `tests/api/memory-status.test.ts`
- `tests/api/memory-rebuild.test.ts`
- `tests/e2e/memory-backfill.spec.ts`

**Modified files:**
- `src/db/schema/index.ts` — re-export new schemas
- `src/engine/index.ts` — export `TOOL_HANDLERS_DB`
- `src/engine/tools/index.ts` — add `lookup_codex` to `ALWAYS_ON`
- `src/engine/tools/handlers.ts` — add `TOOL_HANDLERS_DB` registry export
- `src/ai/master/tool-loop.ts` — accept `db` + `sessionId` in handler dispatch
- `src/ai/master/system-prompt.ts` — accept memory context in prompt builder, append "Memory tools" section
- `src/app/api/sessions/[id]/turn/route.ts` — load memory context, augment prompt, trigger extractor in `waitUntil`

---

## Task 1: Schema — `session_chapters`

**Files:**
- Create: `src/db/schema/session-chapters.ts`
- Modify: `src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

```ts
// src/db/schema/session-chapters.ts
import { pgTable, uuid, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { sessionMessages } from './session-messages';

export const sessionChapters = pgTable(
  'session_chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    chapterIndex: integer('chapter_index').notNull(),
    firstMsgId: uuid('first_msg_id').notNull().references(() => sessionMessages.id, { onDelete: 'restrict' }),
    lastMsgId: uuid('last_msg_id').notNull().references(() => sessionMessages.id, { onDelete: 'restrict' }),
    messageCount: integer('message_count').notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionChapterIdx: index('session_chapters_session_chapter_idx').on(t.sessionId, t.chapterIndex),
    sessionChapterUniq: uniqueIndex('session_chapters_session_chapter_uniq').on(t.sessionId, t.chapterIndex),
  }),
);

export type SessionChapter = typeof sessionChapters.$inferSelect;
export type SessionChapterInsert = typeof sessionChapters.$inferInsert;
```

- [ ] **Step 2: Re-export from schema index**

Append to `src/db/schema/index.ts`:

```ts
export * from './session-chapters';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/session-chapters.ts src/db/schema/index.ts
git commit -m "feat(db): session_chapters schema"
```

---

## Task 2: Schema — `codex_entities` (with kind enum)

**Files:**
- Create: `src/db/schema/codex-entities.ts`
- Modify: `src/db/schema/index.ts`

- [ ] **Step 1: Write the schema file**

```ts
// src/db/schema/codex-entities.ts
import { pgTable, uuid, text, jsonb, pgEnum, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { sessionMessages } from './session-messages';

export const codexKindEnum = pgEnum('codex_kind', [
  'npc',
  'location',
  'quest',
  'faction',
  'lore_fact',
  'named_item',
  'relationship',
]);

export type CodexKind = (typeof codexKindEnum.enumValues)[number];

// Per-kind payload shapes. Validated at write time in patch.ts; `data` column
// is jsonb so the DB stays simple.
export type CodexNpcData = {
  description: string;
  status: 'alive' | 'dead' | 'unknown';
  disposition: 'ally' | 'neutral' | 'hostile' | 'unknown';
  tags: string[];
};
export type CodexLocationData = { description: string; region?: string; tags: string[] };
export type CodexQuestData = {
  description: string;
  status: 'open' | 'completed' | 'failed' | 'abandoned';
  giverSlug?: string;
};
export type CodexFactionData = {
  description: string;
  pcRelation: 'ally' | 'neutral' | 'hostile' | 'unknown';
};
export type CodexLoreFactData = { statement: string; tags: string[] };
export type CodexNamedItemData = { description: string; holderSlug?: string; magical: boolean };
export type CodexRelationshipData = { fromSlug: string; toSlug: string; nature: string };

export type CodexData =
  | CodexNpcData
  | CodexLocationData
  | CodexQuestData
  | CodexFactionData
  | CodexLoreFactData
  | CodexNamedItemData
  | CodexRelationshipData;

export const codexEntities = pgTable(
  'codex_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    kind: codexKindEnum('kind').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    data: jsonb('data').$type<CodexData>().notNull(),
    lastSeenMsgId: uuid('last_seen_msg_id').references(() => sessionMessages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionKindIdx: index('codex_entities_session_kind_idx').on(t.sessionId, t.kind),
    sessionLastSeenIdx: index('codex_entities_session_last_seen_idx').on(t.sessionId, t.lastSeenMsgId),
    sessionKindSlugUniq: uniqueIndex('codex_entities_session_kind_slug_uniq').on(t.sessionId, t.kind, t.slug),
  }),
);

export type CodexEntity = typeof codexEntities.$inferSelect;
export type CodexEntityInsert = typeof codexEntities.$inferInsert;
```

- [ ] **Step 2: Re-export from schema index**

Append to `src/db/schema/index.ts`:

```ts
export * from './codex-entities';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/codex-entities.ts src/db/schema/index.ts
git commit -m "feat(db): codex_entities schema with kind enum"
```

---

## Task 3: Generate + apply migration

**Files:**
- Create: `drizzle/migrations/0008_master_memory.sql` (auto-generated)

- [ ] **Step 1: Generate migration**

Run: `pnpm db:generate`
Expected: Drizzle prints "✓ migration generated" and creates a new file in `drizzle/migrations/`. The new file should contain `CREATE TYPE codex_kind`, `CREATE TABLE session_chapters`, `CREATE TABLE codex_entities`, plus the indexes.

- [ ] **Step 2: Inspect the generated SQL**

Run: `ls -1 drizzle/migrations/ | tail -5`

Open the newest file (numbered 0008 or higher). Verify it contains:
- `CREATE TYPE "public"."codex_kind" AS ENUM('npc','location','quest','faction','lore_fact','named_item','relationship');`
- `CREATE TABLE "session_chapters"` with `id`, `session_id`, `chapter_index`, `first_msg_id`, `last_msg_id`, `message_count`, `summary`, `created_at`.
- `CREATE TABLE "codex_entities"` with the columns listed in Task 2.
- 3 unique/regular indexes for `codex_entities` and 2 for `session_chapters`.
- Foreign-key constraints with the right `ON DELETE` actions.

If anything is wrong, fix the schema files in tasks 1-2 and regenerate (delete the bad migration file first).

- [ ] **Step 3: Apply migration locally**

Run: `pnpm db:migrate`
Expected: prints applied migrations including the new one. No errors.

- [ ] **Step 4: Smoke check tables exist**

Run: `psql "$DATABASE_URL" -c "\dt session_chapters codex_entities"`
Expected: both tables listed.

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/
git commit -m "feat(db): migration for session_chapters + codex_entities"
```

---

## Task 4: Memory types

**Files:**
- Create: `src/sessions/memory/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// src/sessions/memory/types.ts
import type {
  CodexKind,
  CodexNpcData,
  CodexLocationData,
  CodexQuestData,
  CodexFactionData,
  CodexLoreFactData,
  CodexNamedItemData,
  CodexRelationshipData,
} from '@/db/schema/codex-entities';

/** A single upsert instruction for a codex entity. The slug is the primary
 * dedup key together with (sessionId, kind). When the entity already exists,
 * `data` and `name` are overwritten; when it does not, a new row is inserted. */
export interface CodexUpsert {
  kind: CodexKind;
  slug: string;
  name: string;
  data:
    | CodexNpcData
    | CodexLocationData
    | CodexQuestData
    | CodexFactionData
    | CodexLoreFactData
    | CodexNamedItemData
    | CodexRelationshipData;
}

/** Output of the extractor. `chapter` is present only in Full mode. */
export interface MemoryPatch {
  upserts: CodexUpsert[];
  chapter?: {
    chapterIndex: number;
    firstMsgId: string;
    lastMsgId: string;
    messageCount: number;
    summary: string;
  };
  /** ID of the last message read by the extractor in this run. Used to update
   * lastSeenMsgId on every upserted entity. */
  lastSeenMsgId: string;
}

/** Light vs Full mode. Full produces a chapter; Light only updates the codex. */
export type ExtractorMode = 'light' | 'full';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/memory/types.ts
git commit -m "feat(memory): patch + extractor types"
```

---

## Task 5: `applyPatch` — deterministic upserter (TDD)

**Files:**
- Create: `src/sessions/memory/patch.ts`
- Create: `tests/sessions/memory/patch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sessions/memory/patch.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import {
  sessions,
  sessionState,
  sessionMessages,
  codexEntities,
  sessionChapters,
} from '@/db/schema';
import { applyPatch } from '@/sessions/memory/patch';

const TEST_USER = 'user_patch_' + Date.now();
let SESSION_ID = '';
let MSG_A = '';
let MSG_B = '';

describe('applyPatch', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: charId, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
    const [a] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'player', content: 'hello' })
      .returning();
    const [b] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'master', content: 'You meet Aldric.' })
      .returning();
    MSG_A = a!.id;
    MSG_B = b!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where id = ${SESSION_ID}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('inserts a new NPC entity on first upsert', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'npc',
          slug: 'aldric',
          name: 'Aldric',
          data: {
            description: 'Old wizard with a long beard.',
            status: 'alive',
            disposition: 'ally',
            tags: ['mentor'],
          },
        },
      ],
      lastSeenMsgId: MSG_B,
    });

    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.kind, 'npc')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe('aldric');
    expect(rows[0]!.name).toBe('Aldric');
    expect(rows[0]!.lastSeenMsgId).toBe(MSG_B);
  });

  it('is idempotent: re-applying the same patch does not duplicate', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'npc',
          slug: 'aldric',
          name: 'Aldric',
          data: {
            description: 'Old wizard with a long beard.',
            status: 'alive',
            disposition: 'ally',
            tags: ['mentor'],
          },
        },
      ],
      lastSeenMsgId: MSG_B,
    });

    const rows = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.kind, 'npc')));
    expect(rows).toHaveLength(1);
  });

  it('updates name + data on conflict', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [
        {
          kind: 'npc',
          slug: 'aldric',
          name: 'Aldric the Grey',
          data: {
            description: 'Updated description.',
            status: 'alive',
            disposition: 'ally',
            tags: ['mentor', 'archmage'],
          },
        },
      ],
      lastSeenMsgId: MSG_A,
    });

    const [row] = await db
      .select()
      .from(codexEntities)
      .where(and(eq(codexEntities.sessionId, SESSION_ID), eq(codexEntities.slug, 'aldric')));
    expect(row!.name).toBe('Aldric the Grey');
    expect((row!.data as { description: string }).description).toBe('Updated description.');
    // lastSeenMsgId moves to the most recent we passed
    expect(row!.lastSeenMsgId).toBe(MSG_A);
  });

  it('inserts a chapter row when patch includes chapter', async () => {
    await applyPatch(SESSION_ID, {
      upserts: [],
      chapter: {
        chapterIndex: 0,
        firstMsgId: MSG_A,
        lastMsgId: MSG_B,
        messageCount: 2,
        summary: 'A first encounter.',
      },
      lastSeenMsgId: MSG_B,
    });

    const rows = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chapterIndex).toBe(0);
    expect(rows[0]!.summary).toBe('A first encounter.');
  });

  it('rolls back on invalid kind/data shape', async () => {
    const before = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    await expect(
      applyPatch(SESSION_ID, {
        upserts: [
          // npc requires status/disposition/tags — missing here on purpose
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { kind: 'npc', slug: 'broken', name: 'Broken', data: { description: 'x' } as any },
        ],
        lastSeenMsgId: MSG_B,
      }),
    ).rejects.toThrow();
    const after = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(after.length).toBe(before.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/sessions/memory/patch.test.ts`
Expected: FAIL — `applyPatch` is not defined / module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/sessions/memory/patch.ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  codexEntities,
  sessionChapters,
  type CodexEntityInsert,
  type CodexNpcData,
  type CodexLocationData,
  type CodexQuestData,
  type CodexFactionData,
  type CodexLoreFactData,
  type CodexNamedItemData,
  type CodexRelationshipData,
} from '@/db/schema';
import type { CodexUpsert, MemoryPatch } from './types';

function validate(u: CodexUpsert): void {
  const { kind, data } = u;
  const need = (b: boolean, msg: string): void => {
    if (!b) throw new Error(`patch_invalid:${kind}:${msg}`);
  };
  if (typeof u.slug !== 'string' || !u.slug.length) throw new Error(`patch_invalid:${kind}:slug`);
  if (typeof u.name !== 'string' || !u.name.length) throw new Error(`patch_invalid:${kind}:name`);

  if (kind === 'npc') {
    const d = data as CodexNpcData;
    need(typeof d.description === 'string', 'description');
    need(['alive', 'dead', 'unknown'].includes(d.status), 'status');
    need(['ally', 'neutral', 'hostile', 'unknown'].includes(d.disposition), 'disposition');
    need(Array.isArray(d.tags), 'tags');
  } else if (kind === 'location') {
    const d = data as CodexLocationData;
    need(typeof d.description === 'string', 'description');
    need(Array.isArray(d.tags), 'tags');
  } else if (kind === 'quest') {
    const d = data as CodexQuestData;
    need(typeof d.description === 'string', 'description');
    need(['open', 'completed', 'failed', 'abandoned'].includes(d.status), 'status');
  } else if (kind === 'faction') {
    const d = data as CodexFactionData;
    need(typeof d.description === 'string', 'description');
    need(['ally', 'neutral', 'hostile', 'unknown'].includes(d.pcRelation), 'pcRelation');
  } else if (kind === 'lore_fact') {
    const d = data as CodexLoreFactData;
    need(typeof d.statement === 'string' && d.statement.length > 0, 'statement');
    need(Array.isArray(d.tags), 'tags');
  } else if (kind === 'named_item') {
    const d = data as CodexNamedItemData;
    need(typeof d.description === 'string', 'description');
    need(typeof d.magical === 'boolean', 'magical');
  } else if (kind === 'relationship') {
    const d = data as CodexRelationshipData;
    need(typeof d.fromSlug === 'string' && d.fromSlug.length > 0, 'fromSlug');
    need(typeof d.toSlug === 'string' && d.toSlug.length > 0, 'toSlug');
    need(typeof d.nature === 'string', 'nature');
  } else {
    throw new Error(`patch_invalid:unknown_kind:${String(kind)}`);
  }
}

/** Apply a memory patch atomically. Throws on validation failure (whole
 * transaction rolls back). Designed to be safe to retry: upserts use
 * (session_id, kind, slug) as the conflict target; chapters dedup by
 * (session_id, chapter_index). */
export async function applyPatch(sessionId: string, patch: MemoryPatch): Promise<void> {
  for (const u of patch.upserts) validate(u);

  await db.transaction(async (tx) => {
    for (const u of patch.upserts) {
      const row: CodexEntityInsert = {
        sessionId,
        kind: u.kind,
        slug: u.slug,
        name: u.name,
        data: u.data,
        lastSeenMsgId: patch.lastSeenMsgId,
      };
      await tx
        .insert(codexEntities)
        .values(row)
        .onConflictDoUpdate({
          target: [codexEntities.sessionId, codexEntities.kind, codexEntities.slug],
          set: {
            name: row.name,
            data: row.data,
            lastSeenMsgId: row.lastSeenMsgId,
            updatedAt: sql`now()`,
          },
        });
    }

    if (patch.chapter) {
      await tx
        .insert(sessionChapters)
        .values({
          sessionId,
          chapterIndex: patch.chapter.chapterIndex,
          firstMsgId: patch.chapter.firstMsgId,
          lastMsgId: patch.chapter.lastMsgId,
          messageCount: patch.chapter.messageCount,
          summary: patch.chapter.summary,
        })
        .onConflictDoNothing({
          target: [sessionChapters.sessionId, sessionChapters.chapterIndex],
        });
    }
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/sessions/memory/patch.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/memory/patch.ts tests/sessions/memory/patch.test.ts
git commit -m "feat(memory): applyPatch upserts codex entities and inserts chapter rows"
```

---

## Task 6: Extractor prompt

**Files:**
- Create: `src/sessions/memory/prompt.ts`

- [ ] **Step 1: Write the prompt module**

```ts
// src/sessions/memory/prompt.ts
import type { ExtractorMode } from './types';

const BASE_INSTRUCTIONS = `You are a memory extractor for a Dungeons & Dragons 5e campaign that runs in a single-player web app. Your job is to read recent chat between the player and the Dungeon Master, and emit a strict JSON patch that updates the campaign's structured memory (the "codex") and, when in FULL mode, a narrative summary of the new chapter.

You do NOT narrate. You do NOT respond as the DM. You ONLY emit the JSON.

The codex is the source of truth for narrative continuity. The Dungeon Master will read it on the next turn to avoid contradicting itself. Be conservative: only record entities that were actually introduced or meaningfully developed in the messages provided. Do not invent.

## Entity kinds

- "npc": a non-player character with a name. Status: alive/dead/unknown. Disposition toward the PC: ally/neutral/hostile/unknown. Tags: short keywords (race, role, location).
- "location": a named place (tavern, forest, city, dungeon room with a name). Tags: type/atmosphere keywords.
- "quest": a task the player has been given or has taken on. Status: open/completed/failed/abandoned. Optional giverSlug if a known NPC gave it.
- "faction": an organisation, guild, cult, kingdom. pcRelation: ally/neutral/hostile/unknown.
- "lore_fact": a stable fact about the world ("The kingdom is at war with the orcs", "Pelor has a temple in the capital"). Use sparingly — only for facts that the DM should not contradict.
- "named_item": a magical or otherwise unique named item ("Sword of Aldric", "Crown of Storms"). magical: boolean.
- "relationship": a connection between two named entities (NPC-NPC or NPC-faction). fromSlug + toSlug must reference entities that already exist or are being upserted in this same patch. nature is a short free-text description ("brother", "sworn enemy", "leads", "betrayed").

## Slugs

slug = lowercase, ASCII, hyphen-separated, derived from the canonical name. Examples: "Aldric the Grey" -> "aldric-the-grey"; "The Whispering Wood" -> "whispering-wood" (drop articles); "House Ravencrest" -> "house-ravencrest".

When updating an existing entity, USE THE SAME SLUG you'd derive from its canonical name. If you see an entity in the EXISTING CODEX section, prefer its existing slug verbatim — never re-slug it.

## Output format

Output ONLY a JSON object, no prose, no markdown fences. Schema:

{
  "upserts": [
    { "kind": "npc"|"location"|"quest"|"faction"|"lore_fact"|"named_item"|"relationship",
      "slug": "string",
      "name": "string",
      "data": { ... per-kind shape ... }
    }
  ]
  // FULL mode only:
  // "chapterSummary": "string (~200-300 tokens, narrative recap of the chapter)"
}

Per-kind data shapes:
- npc: { description, status, disposition, tags }
- location: { description, region?, tags }
- quest: { description, status, giverSlug? }
- faction: { description, pcRelation }
- lore_fact: { statement, tags }
- named_item: { description, holderSlug?, magical }
- relationship: { fromSlug, toSlug, nature }

## Rules

- Empty upserts array is valid. Do not invent updates that aren't supported by the messages.
- Skip messages that start with "!" — those are out-of-character meta-game messages, not narrative.
- Match the LANGUAGE of the campaign (provided below) for description/statement/summary text.
- Never include any field other than upserts (and chapterSummary in FULL mode). No "explanation", no "notes".`;

const FULL_TAIL = `

## This call: FULL mode (chapter boundary)

You are receiving 40 consecutive non-OOC messages that constitute the next chapter. In addition to the codex upserts, produce a narrative chapter summary in the campaign language: ~200-300 tokens, third-person past tense, focused on what happened, who was involved, decisions made, threads opened/closed. The DM will read this verbatim on every future turn — be precise about names and outcomes.

Output:
{ "upserts": [ ... ], "chapterSummary": "..." }`;

const LIGHT_TAIL = `

## This call: LIGHT mode (single turn)

You are receiving the most recent player message and master response. Update the codex if anything new was introduced or changed (a new NPC named, a quest accepted, an NPC died, a location entered for the first time, etc.). If nothing new happened, return { "upserts": [] }.

Output:
{ "upserts": [ ... ] }`;

export function buildExtractorSystemPrompt(mode: ExtractorMode): string {
  return BASE_INSTRUCTIONS + (mode === 'full' ? FULL_TAIL : LIGHT_TAIL);
}

/** Format the codex into a compact text representation for the extractor's
 * input. Keeps it small to fit token budget. */
export function formatExistingCodex(
  rows: { kind: string; slug: string; name: string; data: unknown }[],
): string {
  if (rows.length === 0) return '(empty codex — this is a fresh campaign)';
  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    const prev = byKind.get(r.kind) ?? [];
    prev.push(`  - ${r.slug}: ${r.name}`);
    byKind.set(r.kind, prev);
  }
  const sections: string[] = [];
  for (const [kind, lines] of byKind) {
    sections.push(`${kind}:\n${lines.join('\n')}`);
  }
  return sections.join('\n');
}

export function formatPreviousChapters(rows: { chapterIndex: number; summary: string }[]): string {
  if (rows.length === 0) return '(no previous chapters)';
  return rows
    .map((r) => `## Chapter ${r.chapterIndex}\n${r.summary}`)
    .join('\n\n');
}

export function formatMessagesForExtractor(
  rows: { id: string; role: string; content: string; createdAt: Date }[],
): string {
  return rows
    .map((m) => `[${m.role.toUpperCase()} ${m.id}] ${m.content}`)
    .join('\n\n');
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/sessions/memory/prompt.ts
git commit -m "feat(memory): extractor prompt + formatters"
```

---

## Task 7: Extractor — `extractMemory` (TDD with fake provider)

**Files:**
- Create: `src/sessions/memory/extractor.ts`
- Create: `tests/sessions/memory/extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sessions/memory/extractor.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql, eq, asc } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import {
  sessions,
  sessionState,
  sessionMessages,
  sessionChapters,
  codexEntities,
} from '@/db/schema';
import { extractMemory, __setExtractorProviderForTest } from '@/sessions/memory/extractor';
import type { MasterProvider, CompleteMessageOutput } from '@/ai/provider/types';

const TEST_USER = 'user_extr_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';

function fakeProvider(jsonReply: string): MasterProvider {
  return {
    name: 'anthropic',
    completeMessage: async (): Promise<CompleteMessageOutput> => ({
      contentBlocks: [{ type: 'text', text: jsonReply }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
    detectLanguage: async () => null,
    proposeWizard: async () => ({
      toolInput: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  };
}

async function freshSession(): Promise<void> {
  const [s] = await db
    .insert(sessions)
    .values({ userId: TEST_USER, characterId: CHAR_ID, premise: 'x' })
    .returning();
  SESSION_ID = s!.id;
  await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
}

async function seedMessages(count: number): Promise<void> {
  // alternate player/master, all non-OOC
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      sessionId: SESSION_ID,
      role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
      content: `message ${i}`,
    });
  }
  await db.insert(sessionMessages).values(rows);
}

describe('extractMemory', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    CHAR_ID = c.id;
  });

  beforeEach(async () => {
    await freshSession();
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
    __setExtractorProviderForTest(null);
  });

  it('light mode: with <40 new messages, runs LIGHT and applies upserts only', async () => {
    await seedMessages(4); // below chapter threshold
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [
            {
              kind: 'npc',
              slug: 'aldric',
              name: 'Aldric',
              data: { description: 'wizard', status: 'alive', disposition: 'ally', tags: [] },
            },
          ],
        }),
      ),
    );

    await extractMemory(SESSION_ID);

    const npcs = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(npcs).toHaveLength(1);
    expect(npcs[0]!.slug).toBe('aldric');
    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapters).toHaveLength(0);
  });

  it('full mode: with 40+ new messages, runs FULL, creates chapter 0', async () => {
    await seedMessages(40);
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [
            {
              kind: 'location',
              slug: 'silver-tavern',
              name: 'Silver Tavern',
              data: { description: 'cozy', tags: ['inn'] },
            },
          ],
          chapterSummary: 'The first chapter, in which the hero entered the Silver Tavern.',
        }),
      ),
    );

    await extractMemory(SESSION_ID);

    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID))
      .orderBy(asc(sessionChapters.chapterIndex));
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.chapterIndex).toBe(0);
    expect(chapters[0]!.messageCount).toBe(40);
    expect(chapters[0]!.summary).toContain('Silver Tavern');
    const locs = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(locs).toHaveLength(1);
  });

  it('full mode: 80 messages -> two chapters (sequential runs)', async () => {
    await seedMessages(80);
    __setExtractorProviderForTest(
      fakeProvider(
        JSON.stringify({
          upserts: [],
          chapterSummary: 'A chapter happened.',
        }),
      ),
    );

    await extractMemory(SESSION_ID); // first call: produces chapter 0
    await extractMemory(SESSION_ID); // second call: produces chapter 1

    const chapters = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID))
      .orderBy(asc(sessionChapters.chapterIndex));
    expect(chapters.map((c) => c.chapterIndex)).toEqual([0, 1]);
  });

  it('OOC messages are excluded from chapter ranges', async () => {
    // 35 normal + 10 OOC + 5 normal => 40 non-OOC, threshold reached
    const rows: { sessionId: string; role: 'player' | 'master'; content: string }[] = [];
    for (let i = 0; i < 35; i++) {
      rows.push({ sessionId: SESSION_ID, role: i % 2 === 0 ? 'player' : 'master', content: 'msg' });
    }
    for (let i = 0; i < 10; i++) {
      rows.push({ sessionId: SESSION_ID, role: 'player', content: '!ooc question' });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({ sessionId: SESSION_ID, role: 'master', content: 'msg' });
    }
    await db.insert(sessionMessages).values(rows);

    __setExtractorProviderForTest(
      fakeProvider(JSON.stringify({ upserts: [], chapterSummary: 'OOC test chapter.' })),
    );
    await extractMemory(SESSION_ID);

    const [chapter] = await db
      .select()
      .from(sessionChapters)
      .where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapter!.messageCount).toBe(40);
  });

  it('malformed JSON: extractor logs and does not throw', async () => {
    await seedMessages(2);
    __setExtractorProviderForTest(fakeProvider('not json at all'));
    await expect(extractMemory(SESSION_ID)).resolves.toBeUndefined();
    const npcs = await db.select().from(codexEntities).where(eq(codexEntities.sessionId, SESSION_ID));
    expect(npcs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/sessions/memory/extractor.test.ts`
Expected: FAIL — `extractMemory` is not defined.

- [ ] **Step 3: Write the implementation**

```ts
// src/sessions/memory/extractor.ts
import { eq, and, asc, gt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessions,
  sessionMessages,
  sessionChapters,
  codexEntities,
  type SessionMessage,
} from '@/db/schema';
import { applyPatch } from './patch';
import {
  buildExtractorSystemPrompt,
  formatExistingCodex,
  formatPreviousChapters,
  formatMessagesForExtractor,
} from './prompt';
import type { CodexUpsert, ExtractorMode, MemoryPatch } from './types';
import { getMasterProvider } from '@/ai/provider';
import type { MasterProvider } from '@/ai/provider/types';

const CHAPTER_SIZE = 40;

let _override: MasterProvider | null = null;
/** Test-only seam. */
export function __setExtractorProviderForTest(p: MasterProvider | null): void {
  _override = p;
}

function provider(): MasterProvider {
  return _override ?? getMasterProvider();
}

function isOoc(content: string): boolean {
  return content.trimStart().startsWith('!');
}

/** Acquire a per-session advisory lock. Returns true if acquired. */
async function tryLock(sessionId: string): Promise<boolean> {
  const r = await db.execute<{ pg_try_advisory_lock: boolean }>(
    sql`select pg_try_advisory_lock(hashtextextended(${sessionId}, 0)) as pg_try_advisory_lock`,
  );
  // drizzle returns rows on .rows; shape may differ across pg drivers. Be defensive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (r as any).rows?.[0] ?? (r as any)[0];
  return row?.pg_try_advisory_lock === true;
}

async function unlock(sessionId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_unlock(hashtextextended(${sessionId}, 0))`,
  );
}

/** Get all messages after a given message id (or all messages if null), in
 * chronological order, excluding OOC. */
async function getNonOocMessagesAfter(
  sessionId: string,
  afterId: string | null,
): Promise<SessionMessage[]> {
  // We need messages strictly after afterId by createdAt. To make that
  // unambiguous when timestamps tie, we order by (createdAt, id).
  if (afterId === null) {
    const rows = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    return rows.filter((r) => !isOoc(r.content));
  }
  const [pivot] = await db
    .select({ createdAt: sessionMessages.createdAt })
    .from(sessionMessages)
    .where(eq(sessionMessages.id, afterId))
    .limit(1);
  if (!pivot) {
    // pivot deleted? fall back to all
    const rows = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    return rows.filter((r) => !isOoc(r.content));
  }
  const rows = await db
    .select()
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), gt(sessionMessages.createdAt, pivot.createdAt)))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  return rows.filter((r) => !isOoc(r.content));
}

interface ExtractorContext {
  sessionId: string;
  language: string | null;
  mode: ExtractorMode;
  inputMessages: SessionMessage[];
  existingCodex: { kind: string; slug: string; name: string; data: unknown }[];
  previousChapters: { chapterIndex: number; summary: string }[];
  nextChapterIndex: number;
}

async function buildContext(sessionId: string): Promise<ExtractorContext | null> {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!s) return null;

  // Find the highest chapter index + its lastMsgId.
  const chapters = await db
    .select()
    .from(sessionChapters)
    .where(eq(sessionChapters.sessionId, sessionId))
    .orderBy(asc(sessionChapters.chapterIndex));
  const lastChapter = chapters[chapters.length - 1] ?? null;
  const afterMsgId = lastChapter?.lastMsgId ?? null;

  const pending = await getNonOocMessagesAfter(sessionId, afterMsgId);

  let mode: ExtractorMode;
  let inputMessages: SessionMessage[];
  if (pending.length >= CHAPTER_SIZE) {
    mode = 'full';
    inputMessages = pending.slice(0, CHAPTER_SIZE);
  } else {
    mode = 'light';
    // Light mode reads the LATEST player+master pair (last 2 non-OOC messages)
    // — usually 2 messages. Using all `pending` is wasteful; using just the
    // last 2 keeps the call cheap and focused.
    inputMessages = pending.slice(-2);
  }
  if (inputMessages.length === 0) return null;

  const existingCodex = await db
    .select({
      kind: codexEntities.kind,
      slug: codexEntities.slug,
      name: codexEntities.name,
      data: codexEntities.data,
    })
    .from(codexEntities)
    .where(eq(codexEntities.sessionId, sessionId));

  return {
    sessionId,
    language: s.language,
    mode,
    inputMessages,
    existingCodex,
    previousChapters: chapters.map((c) => ({ chapterIndex: c.chapterIndex, summary: c.summary })),
    nextChapterIndex: chapters.length,
  };
}

interface RawPatch {
  upserts: CodexUpsert[];
  chapterSummary?: string;
}

function parseModelOutput(text: string): RawPatch | null {
  try {
    // Strip code-fences if the model emits them despite instructions.
    const cleaned = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const obj = JSON.parse(cleaned) as RawPatch;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.upserts)) return null;
    return obj;
  } catch {
    return null;
  }
}

export async function extractMemory(sessionId: string): Promise<void> {
  const acquired = await tryLock(sessionId);
  if (!acquired) return;
  try {
    const ctx = await buildContext(sessionId);
    if (!ctx) return;

    const sys = buildExtractorSystemPrompt(ctx.mode);
    const language = ctx.language ?? 'unknown';

    const userText = [
      `## Campaign language\n${language}`,
      `## Existing codex (compact)\n${formatExistingCodex(ctx.existingCodex)}`,
      ctx.mode === 'full'
        ? `## Previous chapters\n${formatPreviousChapters(ctx.previousChapters)}`
        : null,
      `## Messages to read\n${formatMessagesForExtractor(ctx.inputMessages)}`,
      ctx.mode === 'full'
        ? 'Produce upserts AND chapterSummary. JSON only.'
        : 'Produce upserts. JSON only.',
    ]
      .filter(Boolean)
      .join('\n\n');

    let response;
    try {
      response = await provider().completeMessage({
        model: process.env.MEMORY_EXTRACTOR_MODEL,
        systemBlocks: [{ type: 'text', text: sys }],
        messages: [{ role: 'user', content: userText }],
        tools: [],
        maxTokens: 2000,
        sessionId,
      });
    } catch (e) {
      console.error('extractor.provider_error', e instanceof Error ? e.message : String(e));
      return;
    }

    const text = response.contentBlocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const raw = parseModelOutput(text);
    if (!raw) {
      console.warn('extractor.bad_json', { sessionId, mode: ctx.mode, sample: text.slice(0, 200) });
      return;
    }

    const lastSeenMsgId = ctx.inputMessages[ctx.inputMessages.length - 1]!.id;
    const patch: MemoryPatch = { upserts: raw.upserts, lastSeenMsgId };
    if (ctx.mode === 'full' && typeof raw.chapterSummary === 'string') {
      patch.chapter = {
        chapterIndex: ctx.nextChapterIndex,
        firstMsgId: ctx.inputMessages[0]!.id,
        lastMsgId: lastSeenMsgId,
        messageCount: ctx.inputMessages.length,
        summary: raw.chapterSummary,
      };
    }

    try {
      await applyPatch(sessionId, patch);
    } catch (e) {
      console.error('extractor.apply_failed', e instanceof Error ? e.message : String(e));
    }
  } finally {
    await unlock(sessionId);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/sessions/memory/extractor.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/memory/extractor.ts tests/sessions/memory/extractor.test.ts
git commit -m "feat(memory): extractor with light/full modes and OOC filtering"
```

---

## Task 8: `loadMemoryContext` + scene card selection (TDD)

**Files:**
- Create: `src/sessions/memory/context.ts`
- Create: `tests/sessions/memory/context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sessions/memory/context.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, codexEntities, sessionChapters } from '@/db/schema';
import { loadMemoryContext } from '@/sessions/memory/context';

const TEST_USER = 'user_ctx_' + Date.now();
let SESSION_ID = '';
let CHAR_ID = '';
let MSG_ID = '';

describe('loadMemoryContext', () => {
  beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'P';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    CHAR_ID = c.id;
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: CHAR_ID, premise: 'x' })
      .returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 10, hitDiceRemaining: 1 });
    const [m] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'player', content: 'I look for Aldric.' })
      .returning();
    MSG_ID = m!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('returns empty digests when nothing exists', async () => {
    const ctx = await loadMemoryContext(SESSION_ID, '');
    expect(ctx.chapterDigests).toBe('');
    expect(ctx.sceneCard).toContain('(no entities currently in scene)');
    expect(ctx.codexIndex).toContain('(empty codex)');
  });

  it('includes open quests in scene card always', async () => {
    await db.insert(codexEntities).values({
      sessionId: SESSION_ID,
      kind: 'quest',
      slug: 'find-aldric',
      name: 'Find Aldric',
      data: { description: 'Search the old wizard out.', status: 'open' },
    });
    const ctx = await loadMemoryContext(SESSION_ID, 'a generic scene');
    expect(ctx.sceneCard).toContain('Find Aldric');
  });

  it('matches NPC names by substring in player message / scene', async () => {
    await db.insert(codexEntities).values({
      sessionId: SESSION_ID,
      kind: 'npc',
      slug: 'aldric',
      name: 'Aldric',
      data: { description: 'wizard', status: 'alive', disposition: 'ally', tags: [] },
    });
    const ctx = await loadMemoryContext(SESSION_ID, 'a generic scene');
    expect(ctx.sceneCard).toContain('Aldric');
  });

  it('codexIndex lists all entities by kind', async () => {
    const ctx = await loadMemoryContext(SESSION_ID, '');
    expect(ctx.codexIndex).toContain('npcs:');
    expect(ctx.codexIndex).toContain('Aldric');
    expect(ctx.codexIndex).toContain('quests:');
    expect(ctx.codexIndex).toContain('Find Aldric');
  });

  it('chapterDigests concatenates summaries with chapter headers', async () => {
    await db.insert(sessionChapters).values({
      sessionId: SESSION_ID,
      chapterIndex: 0,
      firstMsgId: MSG_ID,
      lastMsgId: MSG_ID,
      messageCount: 1,
      summary: 'The hero began their journey.',
    });
    const ctx = await loadMemoryContext(SESSION_ID, '');
    expect(ctx.chapterDigests).toContain('## Chapter 0');
    expect(ctx.chapterDigests).toContain('The hero began their journey.');
  });

  it('scene card capped at 15 entries', async () => {
    // Insert 20 quests, all open.
    for (let i = 0; i < 20; i++) {
      await db.insert(codexEntities).values({
        sessionId: SESSION_ID,
        kind: 'quest',
        slug: `q-${i}`,
        name: `Quest ${i}`,
        data: { description: 'x', status: 'open' },
      });
    }
    const ctx = await loadMemoryContext(SESSION_ID, '');
    const matches = ctx.sceneCard.match(/Quest \d+/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(15);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/sessions/memory/context.test.ts`
Expected: FAIL — `loadMemoryContext` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/sessions/memory/context.ts
import { eq, and, asc, desc, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessionMessages,
  sessionChapters,
  codexEntities,
  type CodexEntity,
  type CodexQuestData,
} from '@/db/schema';

export interface MemoryContext {
  chapterDigests: string;
  sceneCard: string;
  codexIndex: string;
}

const SCENE_CARD_CAP = 15;
const RECENT_MESSAGES_FOR_LASTSEEN = 5;

function formatEntityForCard(e: CodexEntity): string {
  const dataPreview = ((): string => {
    if (e.kind === 'npc') {
      const d = e.data as { description: string; status: string; disposition: string };
      return `[${d.status}, ${d.disposition}] ${d.description}`;
    }
    if (e.kind === 'quest') {
      const d = e.data as CodexQuestData;
      return `[${d.status}] ${d.description}`;
    }
    if (e.kind === 'location') {
      const d = e.data as { description: string };
      return d.description;
    }
    if (e.kind === 'lore_fact') {
      const d = e.data as { statement: string };
      return d.statement;
    }
    if (e.kind === 'faction') {
      const d = e.data as { description: string; pcRelation: string };
      return `[${d.pcRelation}] ${d.description}`;
    }
    if (e.kind === 'named_item') {
      const d = e.data as { description: string };
      return d.description;
    }
    if (e.kind === 'relationship') {
      const d = e.data as { fromSlug: string; toSlug: string; nature: string };
      return `${d.fromSlug} → ${d.toSlug}: ${d.nature}`;
    }
    return '';
  })();
  return `- (${e.kind}) ${e.name} [${e.slug}]: ${dataPreview}`;
}

export async function loadMemoryContext(sessionId: string, sceneText: string): Promise<MemoryContext> {
  // Chapter digests — all chapters in order.
  const chapters = await db
    .select({ chapterIndex: sessionChapters.chapterIndex, summary: sessionChapters.summary })
    .from(sessionChapters)
    .where(eq(sessionChapters.sessionId, sessionId))
    .orderBy(asc(sessionChapters.chapterIndex));

  const chapterDigests =
    chapters.length === 0
      ? ''
      : chapters.map((c) => `## Chapter ${c.chapterIndex}\n${c.summary}`).join('\n\n');

  // Codex full read.
  const allEntities = await db
    .select()
    .from(codexEntities)
    .where(eq(codexEntities.sessionId, sessionId));

  // codex index — bare names per kind.
  let codexIndex = '';
  if (allEntities.length === 0) {
    codexIndex = '(empty codex)';
  } else {
    const byKind = new Map<string, string[]>();
    for (const e of allEntities) {
      const arr = byKind.get(e.kind) ?? [];
      arr.push(e.name);
      byKind.set(e.kind, arr);
    }
    codexIndex = Array.from(byKind.entries())
      .map(([k, ns]) => `${k}s: [${ns.join(', ')}]`)
      .join('\n');
  }

  // Scene card selection:
  // 1. open quests (always)
  // 2. entities whose name or slug appears in sceneText or last player message
  // 3. entities last_seen_msg_id within the last RECENT_MESSAGES_FOR_LASTSEEN messages
  // dedup by id; cap at SCENE_CARD_CAP, sort by lastSeenMsgId desc nulls last.

  const lastPlayerRows = await db
    .select({ id: sessionMessages.id, content: sessionMessages.content })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, 'player')))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(1);
  const lastPlayerText = lastPlayerRows[0]?.content ?? '';
  const haystack = `${sceneText}\n${lastPlayerText}`.toLowerCase();

  const recentMsgRows = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(RECENT_MESSAGES_FOR_LASTSEEN);
  const recentIds = new Set(recentMsgRows.map((r) => r.id));

  const picked = new Map<string, CodexEntity>();

  for (const e of allEntities) {
    if (e.kind === 'quest') {
      const d = e.data as CodexQuestData;
      if (d.status === 'open') picked.set(e.id, e);
      continue;
    }
    const slugMatch = haystack.includes(e.slug.toLowerCase());
    const nameMatch = haystack.includes(e.name.toLowerCase());
    if (slugMatch || nameMatch) {
      picked.set(e.id, e);
      continue;
    }
    if (e.lastSeenMsgId && recentIds.has(e.lastSeenMsgId)) {
      picked.set(e.id, e);
    }
  }

  const sorted = Array.from(picked.values()).sort((a, b) => {
    // Most recently seen first; nulls go last.
    if (!a.lastSeenMsgId && !b.lastSeenMsgId) return 0;
    if (!a.lastSeenMsgId) return 1;
    if (!b.lastSeenMsgId) return -1;
    return a.lastSeenMsgId === b.lastSeenMsgId ? 0 : a.lastSeenMsgId > b.lastSeenMsgId ? -1 : 1;
  });
  const capped = sorted.slice(0, SCENE_CARD_CAP);

  const sceneCard =
    capped.length === 0
      ? '(no entities currently in scene)'
      : capped.map(formatEntityForCard).join('\n');

  // Suppress unused-import warning for inArray; remove when unused.
  void inArray;

  return { chapterDigests, sceneCard, codexIndex };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/sessions/memory/context.test.ts`
Expected: PASS — 6 cases.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/memory/context.ts tests/sessions/memory/context.test.ts
git commit -m "feat(memory): loadMemoryContext + scene card selection"
```

---

## Task 9: Add `lookup_codex` to tool definitions

**Files:**
- Modify: `src/engine/tools/index.ts` (add definition to `ALWAYS_ON`)

- [ ] **Step 1: Add the tool definition**

In `src/engine/tools/index.ts`, append to the `ALWAYS_ON` array, before the closing `];`:

```ts
{
  name: 'lookup_codex',
  description:
    "Look up a campaign-codex entity by kind + name/slug. Use when an NPC, location, quest, faction, lore fact, named item, or relationship is referenced in chat and is NOT already visible in the Scene card. The codex is the single source of truth for narrative continuity — prefer it over re-inventing details. Returns up to 5 matches; returns an empty array when nothing matches.",
  input_schema: {
    type: 'object',
    required: ['kind', 'query'],
    properties: {
      kind: {
        type: 'string',
        enum: ['npc', 'location', 'quest', 'faction', 'lore_fact', 'named_item', 'relationship'],
      },
      query: {
        type: 'string',
        description: 'Name or slug to look up. Case-insensitive substring match on slug AND name.',
      },
    },
  } as never,
},
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/engine/tools/index.ts
git commit -m "feat(tools): add lookup_codex tool definition"
```

---

## Task 10: `TOOL_HANDLERS_DB` registry + `lookup_codex` handler (TDD)

**Files:**
- Create: `src/engine/tools/lookup-codex.ts`
- Modify: `src/engine/tools/handlers.ts` (add export)
- Modify: `src/engine/index.ts` (re-export)
- Create: `tests/engine/lookup-codex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/lookup-codex.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/engine/lookup-codex.test.ts`
Expected: FAIL — `lookupCodex` not found.

- [ ] **Step 3: Write the handler**

```ts
// src/engine/tools/lookup-codex.ts
import { eq, and, ilike, or, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { codexEntities } from '@/db/schema';
import type { ActionResult } from '../types';

const VALID_KINDS = ['npc', 'location', 'quest', 'faction', 'lore_fact', 'named_item', 'relationship'];
const MAX_RESULT_BYTES = 2048;
const MAX_MATCHES = 5;

export interface LookupCodexCtx {
  sessionId: string;
}

export async function lookupCodex(
  ctx: LookupCodexCtx,
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const kind = String(input.kind ?? '');
  const query = String(input.query ?? '');
  if (!VALID_KINDS.includes(kind)) {
    return { ok: false, error: `invalid_kind:${kind}`, rolls: [], mutations: [] };
  }
  if (!query) {
    return { ok: false, error: 'invalid_query:empty', rolls: [], mutations: [] };
  }
  const pattern = `%${query}%`;
  const rows = await db
    .select()
    .from(codexEntities)
    .where(
      and(
        eq(codexEntities.sessionId, ctx.sessionId),
        eq(codexEntities.kind, kind as never),
        or(ilike(codexEntities.slug, pattern), ilike(codexEntities.name, pattern)),
      ),
    )
    .orderBy(desc(sql`coalesce(${codexEntities.lastSeenMsgId}::text, '')`))
    .limit(MAX_MATCHES);

  let truncated = false;
  const matches = rows.map((r) => ({
    kind: r.kind,
    slug: r.slug,
    name: r.name,
    data: r.data,
    lastSeenMsgId: r.lastSeenMsgId,
  }));

  let payload = { matches, truncated };
  if (JSON.stringify(payload).length > MAX_RESULT_BYTES) {
    truncated = true;
    // Drop large `data` fields to fit budget — keep names only.
    payload = {
      matches: matches.map((m) => ({ ...m, data: { description: '(truncated)' } as never })),
      truncated,
    };
  }

  return { ok: true, data: payload, rolls: [], mutations: [] };
}
```

- [ ] **Step 4: Add `TOOL_HANDLERS_DB` registry**

Append to `src/engine/tools/handlers.ts` at the end:

```ts
import { lookupCodex } from './lookup-codex';

export interface DbToolCtx {
  sessionId: string;
}

export type DbToolHandler = (
  ctx: DbToolCtx,
  input: Record<string, unknown>,
) => Promise<import('../types').ActionResult>;

export const TOOL_HANDLERS_DB: Record<string, DbToolHandler> = {
  lookup_codex: (ctx, input) => lookupCodex(ctx, input),
};
```

- [ ] **Step 5: Re-export from engine index**

Append to `src/engine/index.ts`:

```ts
export { TOOL_HANDLERS_DB } from './tools/handlers';
export type { DbToolCtx, DbToolHandler } from './tools/handlers';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/engine/lookup-codex.test.ts`
Expected: PASS — 5 cases.

- [ ] **Step 7: Commit**

```bash
git add src/engine/tools/lookup-codex.ts src/engine/tools/handlers.ts src/engine/index.ts tests/engine/lookup-codex.test.ts
git commit -m "feat(tools): TOOL_HANDLERS_DB registry + lookup_codex handler"
```

---

## Task 11: Wire `runToolLoop` to dispatch DB-aware handlers

**Files:**
- Modify: `src/ai/master/tool-loop.ts`
- Modify: existing tool-loop tests if any references break

- [ ] **Step 1: Locate and read the existing dispatch block**

Open `src/ai/master/tool-loop.ts`. The current dispatch is around lines 115-125:

```ts
const handler = TOOL_HANDLERS[tu.name];
let result: ActionResult;
if (!handler) {
  result = { ok: false, error: `unknown_tool:${tu.name}`, rolls: [], mutations: [] };
} else {
  try {
    result = handler(state, tu.input);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
  }
}
```

- [ ] **Step 2: Replace it with two-tier dispatch**

In the same file, near the top, update imports:

```ts
import { TOOL_HANDLERS, TOOL_DEFINITIONS, TOOL_HANDLERS_DB } from '@/engine';
```

Then replace the dispatch block (the `const handler = TOOL_HANDLERS[tu.name]` block above) with:

```ts
const syncHandler = TOOL_HANDLERS[tu.name];
const dbHandler = TOOL_HANDLERS_DB[tu.name];
let result: ActionResult;
if (syncHandler) {
  try {
    result = syncHandler(state, tu.input);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
  }
} else if (dbHandler) {
  if (!sessionId) {
    result = { ok: false, error: 'missing_session_for_db_tool', rolls: [], mutations: [] };
  } else {
    try {
      result = await dbHandler({ sessionId }, tu.input);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
    }
  }
} else {
  result = { ok: false, error: `unknown_tool:${tu.name}`, rolls: [], mutations: [] };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run the existing tool-loop tests to make sure nothing broke**

Run: `pnpm vitest run tests/ai`
Expected: PASS — existing master/tool-loop tests still green.

- [ ] **Step 5: Add a unit test for the new dispatch path**

Create `tests/ai/tool-loop-db.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/ai/master/tool-loop';
import type { MasterProvider, CompleteMessageOutput } from '@/ai/provider/types';
import type { EngineState } from '@/engine/types';

describe('runToolLoop DB-aware dispatch', () => {
  it('dispatches a TOOL_HANDLERS_DB tool when called with sessionId', async () => {
    const provider: MasterProvider = {
      name: 'anthropic',
      detectLanguage: async () => null,
      proposeWizard: async () => ({
        toolInput: {},
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
      completeMessage: vi
        .fn<[unknown], Promise<CompleteMessageOutput>>()
        .mockResolvedValueOnce({
          contentBlocks: [
            { type: 'tool_use', id: 't1', name: 'lookup_codex', input: { kind: 'npc', query: 'x' } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        })
        .mockResolvedValueOnce({
          contentBlocks: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
    };

    const state = {
      characters: [],
      combatActors: [],
      runtime: {},
      combat: null,
      scene: '',
    } as unknown as EngineState;

    const r = await runToolLoop({
      provider,
      systemBlocks: [{ type: 'text', text: 's' }],
      history: [{ role: 'user', content: 'hi' }],
      state,
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.toolCallCount).toBe(1);
    // The DB handler is real but the session has no codex rows -> empty matches; still ok=true.
    const toolEnd = r.events.find((e) => e.type === 'tool_use_end');
    expect(toolEnd && 'ok' in toolEnd && toolEnd.ok).toBe(true);
  });
});
```

- [ ] **Step 6: Run new test**

Run: `pnpm vitest run tests/ai/tool-loop-db.test.ts`
Expected: PASS.

Note: this test hits the real DB through `lookupCodex`. The session id `00000000-...` doesn't exist; the WHERE clause returns 0 rows; `matches: []` is the expected payload.

- [ ] **Step 7: Commit**

```bash
git add src/ai/master/tool-loop.ts tests/ai/tool-loop-db.test.ts
git commit -m "feat(tool-loop): two-tier dispatch with TOOL_HANDLERS_DB"
```

---

## Task 12: Inject memory context into master system prompt

**Files:**
- Modify: `src/ai/master/system-prompt.ts`

- [ ] **Step 1: Extend `MasterPromptInput` and `buildMasterSystemPrompt`**

In `src/ai/master/system-prompt.ts`:

1. Add to `MasterPromptInput` (right before the closing `}`):

```ts
  /** Concatenated chapter summaries (oldest → newest). Empty string if none. */
  chapterDigests?: string;
  /** Compact card of in-scene + open-quest entities. Empty string treated as none. */
  sceneCard?: string;
  /** Bare-name codex index per kind, for the master to know what's lookup-able. */
  codexIndex?: string;
```

2. Add a new constant block, near the other constants:

```ts
export const MASTER_MEMORY_TOOL_RULE = `## Memory tools

The codex (a structured store of NPCs, locations, quests, factions, lore facts, named items, and relationships) is the single source of truth for narrative continuity. It is updated automatically after every turn. You do NOT write to the codex directly.

You read the codex in two ways:

1. The **Scene card** below already lists the entities most likely relevant to the current turn (in-scene NPCs, open quests, recently mentioned). Use that first — no tool call needed.
2. If the chat references an entity (NPC, location, quest, etc.) that is NOT in the Scene card and you need its details (status, description, who's involved, etc.), call \`lookup_codex({ kind, query })\`. Returns up to 5 fuzzy matches.

Hard rule: if the codex has a fact, **do not contradict it**. If you can't find a needed entity via \`lookup_codex\`, narrate carefully — describe only what you can support — rather than inventing details that may conflict with what's already established. The Codex index below tells you what kinds of entities exist, even when their full data isn't on screen.`;
```

3. Inside `buildMasterSystemPrompt`, after the existing static blocks (after the SRD block) and BEFORE the per-user behavior rules, add the memory blocks. Replace the relevant portion of the function body so it looks like:

```ts
export function buildMasterSystemPrompt(input: MasterPromptInput): { system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] } {
  const langHint = input.language ? `\n\nNarrative language for this session: ${input.language}. Mirror it.` : '';
  const dynamicTail = `## Current snapshot\n\n### Character\n\`\`\`json\n${input.characterMonoSpace}\n\`\`\`\n\n### Scene\n${input.scene || '(no scene set yet)'}${langHint}`;

  const blocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] = [
    { type: 'text', text: MASTER_SYSTEM_PROMPT_BASE, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: MASTER_TOOL_CONTRACT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: MASTER_MEMORY_TOOL_RULE, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: input.srdContext, cache_control: { type: 'ephemeral' } },
  ];

  // Memory injection — these vary across turns of the same session as the codex grows,
  // but are stable WITHIN a turn so we can mark chapterDigests as cacheable.
  if (input.chapterDigests && input.chapterDigests.length > 0) {
    blocks.push({
      type: 'text',
      text: `## Campaign chapter digests\n\n${input.chapterDigests}`,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (input.codexIndex && input.codexIndex.length > 0) {
    blocks.push({
      type: 'text',
      text: `## Codex index\n\n${input.codexIndex}`,
    });
  }
  if (input.sceneCard && input.sceneCard.length > 0) {
    blocks.push({
      type: 'text',
      text: `## Scene card\n\n${input.sceneCard}`,
    });
  }

  // Per-user behaviour rules (existing logic, unchanged).
  if (input.manualRolls) {
    blocks.push({ type: 'text', text: MASTER_MANUAL_ROLLS_RULE });
  }
  const guidance = input.masterGuidanceLevel ?? 'balanced';
  if (guidance === 'free') {
    blocks.push({ type: 'text', text: MASTER_GUIDANCE_FREE });
  } else if (guidance === 'structured') {
    blocks.push({ type: 'text', text: MASTER_GUIDANCE_STRUCTURED });
  } else {
    blocks.push({ type: 'text', text: MASTER_GUIDANCE_BALANCED });
  }
  if (input.showDifficultyNumbers === false) {
    blocks.push({ type: 'text', text: MASTER_HIDE_DIFFICULTY_RULE });
  }
  blocks.push({ type: 'text', text: dynamicTail });
  return { system: blocks };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run existing prompt tests if any**

Run: `pnpm vitest run tests/ai`
Expected: PASS (existing tests still green).

- [ ] **Step 4: Add a small assertion test**

Create `tests/ai/master-prompt-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';

describe('buildMasterSystemPrompt with memory', () => {
  const baseInput = {
    srdContext: '## SRD\nfoo',
    characterMonoSpace: '{}',
    scene: 'a hill',
    language: 'en',
  };

  it('does NOT add memory blocks when fields are missing', () => {
    const { system } = buildMasterSystemPrompt(baseInput);
    const all = system.map((b) => b.text).join('\n');
    expect(all).not.toContain('Campaign chapter digests');
    expect(all).not.toContain('Codex index');
    expect(all).not.toContain('Scene card');
    expect(all).toContain('Memory tools');
  });

  it('adds chapter digests + scene card + codex index when provided', () => {
    const { system } = buildMasterSystemPrompt({
      ...baseInput,
      chapterDigests: '## Chapter 0\nThe hero began their journey.',
      sceneCard: '- (npc) Aldric [aldric]: ally',
      codexIndex: 'npcs: [Aldric]',
    });
    const all = system.map((b) => b.text).join('\n');
    expect(all).toContain('Campaign chapter digests');
    expect(all).toContain('## Chapter 0');
    expect(all).toContain('Codex index');
    expect(all).toContain('npcs: [Aldric]');
    expect(all).toContain('Scene card');
    expect(all).toContain('Aldric');
  });
});
```

- [ ] **Step 5: Run new test**

Run: `pnpm vitest run tests/ai/master-prompt-memory.test.ts`
Expected: PASS — 2 cases.

- [ ] **Step 6: Commit**

```bash
git add src/ai/master/system-prompt.ts tests/ai/master-prompt-memory.test.ts
git commit -m "feat(master): inject memory context blocks + memory tool rule"
```

---

## Task 13: Wire memory context + extractor into the turn route

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Update imports at the top**

In `src/app/api/sessions/[id]/turn/route.ts`, add to the imports near the top:

```ts
import { waitUntil } from '@vercel/functions';
import { loadMemoryContext } from '@/sessions/memory/context';
import { extractMemory } from '@/sessions/memory/extractor';
```

- [ ] **Step 2: Inject memory context into prompt build**

Find the existing `buildMasterSystemPrompt(...)` call. Right before it, add:

```ts
const memory = await loadMemoryContext(sessionId, snap.scene);
```

And update the call:

```ts
const sys = buildMasterSystemPrompt({
  srdContext: srd,
  characterMonoSpace: snap.characterMonoSpace,
  scene: snap.scene,
  language: snap.language,
  manualRolls: userPrefs.manualRolls,
  masterGuidanceLevel: userPrefs.masterGuidanceLevel,
  showDifficultyNumbers: userPrefs.showDifficultyNumbers,
  chapterDigests: memory.chapterDigests,
  sceneCard: memory.sceneCard,
  codexIndex: memory.codexIndex,
});
```

- [ ] **Step 3: Trigger extractor via `waitUntil` after master message persisted**

Find the block that persists the master message:

```ts
if (result.finalText.trim()) {
  const [mm] = await db.insert(sessionMessages).values({ sessionId, role: 'master', content: result.finalText }).returning();
  send('turn_complete', ...);
}
```

Insert, immediately after `const [mm] = await db.insert(...)` and before `send(...)`:

```ts
waitUntil(extractMemory(sessionId).catch((e) => {
  console.error('memory.extract.fire_and_forget', e instanceof Error ? e.message : String(e));
}));
```

- [ ] **Step 4: Typecheck + run all tests**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

```bash
pnpm dev
```

Open the app, run a few turns in an existing session, observe:
- The chat works as before (no UX regression).
- Server logs do not show `memory.extract.*` errors.
- After a few turns, query: `psql "$DATABASE_URL" -c "select kind, slug, name from codex_entities where session_id = '<your-sessionid>'"` — at least some entities should appear within ~1-2 turns.

Stop the dev server before committing.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/sessions/[id]/turn/route.ts
git commit -m "feat(turn): inject memory context + fire async extractor via waitUntil"
```

---

## Task 14: Memory status endpoint (TDD)

**Files:**
- Create: `src/app/api/sessions/[id]/memory/status/route.ts`
- Create: `tests/api/memory-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/memory-status.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, sessionChapters } from '@/db/schema';

const TEST_USER = 'user_memstatus_' + Date.now();
let SESSION_ID = '';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: TEST_USER }),
}));

async function call(): Promise<{ status: number; json: unknown }> {
  const { GET } = await import('@/app/api/sessions/[id]/memory/status/route');
  const req = new Request(`http://localhost/api/sessions/${SESSION_ID}/memory/status`);
  const res = await GET(req as never, { params: Promise.resolve({ id: SESSION_ID }) });
  return { status: res.status, json: await res.json() };
}

describe('GET /api/sessions/:id/memory/status', () => {
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
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('reports messageCount=0, chapterCount=0, needsBackfill=false on empty', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ messageCount: 0, chapterCount: 0, needsBackfill: false });
  });

  it('needsBackfill=true when 40+ messages and 0 chapters', async () => {
    const rows = [];
    for (let i = 0; i < 42; i++) {
      rows.push({
        sessionId: SESSION_ID,
        role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
        content: 'm',
      });
    }
    await db.insert(sessionMessages).values(rows);

    const r = await call();
    expect(r.json).toMatchObject({ messageCount: 42, chapterCount: 0, needsBackfill: true });
  });

  it('OOC messages excluded from messageCount', async () => {
    await db.execute(sql`delete from session_messages where session_id = ${SESSION_ID}`);
    await db.insert(sessionMessages).values([
      { sessionId: SESSION_ID, role: 'player', content: 'normal' },
      { sessionId: SESSION_ID, role: 'player', content: '!ooc' },
    ]);
    const r = await call();
    expect(r.json).toMatchObject({ messageCount: 1 });
  });

  it('needsBackfill=false once a chapter exists', async () => {
    const [m1] = await db
      .insert(sessionMessages)
      .values({ sessionId: SESSION_ID, role: 'player', content: 'a' })
      .returning();
    await db.insert(sessionChapters).values({
      sessionId: SESSION_ID,
      chapterIndex: 0,
      firstMsgId: m1!.id,
      lastMsgId: m1!.id,
      messageCount: 1,
      summary: 's',
    });
    // Add 50 more messages to push messageCount > 40 again.
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push({
        sessionId: SESSION_ID,
        role: 'player' as const,
        content: 'm',
      });
    }
    await db.insert(sessionMessages).values(rows);

    const r = await call();
    expect(r.json).toMatchObject({ chapterCount: 1, needsBackfill: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/api/memory-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the endpoint**

```ts
// src/app/api/sessions/[id]/memory/status/route.ts
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, count, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages, sessionChapters } from '@/db/schema';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return json({ error: 'unauthenticated' }, 401);
  const { id: sessionId } = await params;

  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return json({ error: 'not-found' }, 404);

  // count non-OOC messages
  const [msgRow] = await db
    .select({ c: count() })
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.sessionId, sessionId),
        sql`left(trim(${sessionMessages.content}), 1) <> '!'`,
      ),
    );
  const messageCount = Number(msgRow?.c ?? 0);

  const [chRow] = await db
    .select({ c: count() })
    .from(sessionChapters)
    .where(eq(sessionChapters.sessionId, sessionId));
  const chapterCount = Number(chRow?.c ?? 0);

  const needsBackfill = messageCount >= 40 && chapterCount === 0;

  return json({ messageCount, chapterCount, needsBackfill }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/api/memory-status.test.ts`
Expected: PASS — 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sessions/[id]/memory/status/route.ts tests/api/memory-status.test.ts
git commit -m "feat(memory): GET /memory/status endpoint"
```

---

## Task 15: Memory rebuild endpoint with SSE progress (TDD)

**Files:**
- Create: `src/app/api/sessions/[id]/memory/rebuild/route.ts`
- Create: `tests/api/memory-rebuild.test.ts`

- [ ] **Step 1: Add a rebuild orchestrator function in the extractor module**

Append to `src/sessions/memory/extractor.ts`:

```ts
export async function* rebuildMemoryStream(
  sessionId: string,
): AsyncGenerator<{ event: 'chapter_done' | 'complete' | 'error'; data: unknown }, void, unknown> {
  const acquired = await tryLock(sessionId);
  if (!acquired) {
    yield { event: 'error', data: { reason: 'locked' } };
    return;
  }
  try {
    // Wipe existing memory for this session.
    await db.delete(codexEntities).where(eq(codexEntities.sessionId, sessionId));
    await db.delete(sessionChapters).where(eq(sessionChapters.sessionId, sessionId));

    // Count total non-OOC messages -> totalChapters.
    const allMsgs = await getNonOocMessagesAfter(sessionId, null);
    const totalChapters = Math.floor(allMsgs.length / CHAPTER_SIZE);

    for (let i = 0; i < totalChapters; i++) {
      // extractMemory sees no chapters initially → produces chapter 0; then 1; etc.
      // We unlock and re-lock around each call so extractMemory's own lock works.
      await unlock(sessionId);
      await extractMemory(sessionId);
      const re = await tryLock(sessionId);
      if (!re) {
        // Should not happen — we just released it. Bail safely.
        yield { event: 'error', data: { reason: 'lock_lost' } };
        return;
      }
      yield { event: 'chapter_done', data: { index: i, total: totalChapters } };
    }
    yield { event: 'complete', data: { totalChapters } };
  } finally {
    await unlock(sessionId);
  }
}
```

Add `eq` to the imports if not already there:

```ts
import { eq } from 'drizzle-orm';
```

(The existing top of file has `eq, and, asc, gt, sql` — `eq` should already be there.)

- [ ] **Step 2: Write the failing endpoint test**

```ts
// tests/api/memory-rebuild.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, sessionChapters } from '@/db/schema';
import { __setExtractorProviderForTest } from '@/sessions/memory/extractor';

const TEST_USER = 'user_rebuild_' + Date.now();
let SESSION_ID = '';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: TEST_USER }),
}));

async function readSse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { event: string; data: unknown }[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const ev = p.match(/^event: (.+)$/m)?.[1];
      const data = p.match(/^data: (.+)$/m)?.[1];
      if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
    }
  }
  return events;
}

describe('POST /api/sessions/:id/memory/rebuild', () => {
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
    // 80 non-OOC messages → 2 chapters expected.
    const rows = [];
    for (let i = 0; i < 80; i++) {
      rows.push({
        sessionId: SESSION_ID,
        role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
        content: `m${i}`,
      });
    }
    await db.insert(sessionMessages).values(rows);

    __setExtractorProviderForTest({
      name: 'anthropic',
      detectLanguage: async () => null,
      proposeWizard: async () => ({
        toolInput: {},
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
      completeMessage: async () => ({
        contentBlocks: [
          { type: 'text', text: JSON.stringify({ upserts: [], chapterSummary: 'fake summary' }) },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    });
  });

  afterAll(async () => {
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
    __setExtractorProviderForTest(null);
  });

  it('produces chapters and SSE progress events', async () => {
    const { POST } = await import('@/app/api/sessions/[id]/memory/rebuild/route');
    const req = new Request(`http://localhost/api/sessions/${SESSION_ID}/memory/rebuild`, {
      method: 'POST',
    });
    const res = await POST(req as never, { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(res);
    // expect chapter_done x2 and complete
    const kinds = events.map((e) => e.event);
    expect(kinds.filter((k) => k === 'chapter_done').length).toBe(2);
    expect(kinds[kinds.length - 1]).toBe('complete');

    const chapters = await db.select().from(sessionChapters).where(eq(sessionChapters.sessionId, SESSION_ID));
    expect(chapters).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/api/memory-rebuild.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the endpoint**

```ts
// src/app/api/sessions/[id]/memory/rebuild/route.ts
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { rebuildMemoryStream } from '@/sessions/memory/extractor';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) return json({ error: 'unauthenticated' }, 401);
  const { id: sessionId } = await params;

  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return json({ error: 'not-found' }, 404);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const evt of rebuildMemoryStream(sessionId)) {
          if (evt.event === 'error') {
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify(evt.data)}\n\n`),
            );
            break;
          }
          controller.enqueue(
            encoder.encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`),
          );
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: e instanceof Error ? e.message : String(e) })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run tests/api/memory-rebuild.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/sessions/[id]/memory/rebuild/route.ts src/sessions/memory/extractor.ts tests/api/memory-rebuild.test.ts
git commit -m "feat(memory): POST /memory/rebuild SSE endpoint + rebuildMemoryStream"
```

---

## Task 16: Memory status banner UI

**Files:**
- Create: `src/components/memory-status-banner.tsx`
- Modify: the session chat page to render the banner (find via grep)

- [ ] **Step 1: Locate where to mount the banner**

Run: `grep -rn "session.*page\|session-chat\|chat.*Page" src/app --include="*.tsx" -l | head -5`

Open the session chat page (likely `src/app/(...)/session/[id]/page.tsx` or similar). Identify the top-of-chat slot. The banner needs: `sessionId` and a callback when backfill ends to re-enable the chat input.

- [ ] **Step 2: Write the banner component**

```tsx
// src/components/memory-status-banner.tsx
'use client';

import { useEffect, useState } from 'react';

interface Props {
  sessionId: string;
  /** Called when backfill finishes (or when we determine no backfill is needed). */
  onReady: () => void;
}

interface Progress {
  index: number;
  total: number;
}

export function MemoryStatusBanner({ sessionId, onReady }: Props): React.ReactElement | null {
  const [phase, setPhase] = useState<'checking' | 'rebuilding' | 'done' | 'error'>('checking');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    let abort: AbortController | null = null;

    (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/memory/status`);
        if (!res.ok) {
          // 404/500 etc — proceed without backfill.
          if (!aborted) {
            setPhase('done');
            onReady();
          }
          return;
        }
        const data = (await res.json()) as { needsBackfill: boolean; messageCount: number };
        if (!data.needsBackfill) {
          if (!aborted) {
            setPhase('done');
            onReady();
          }
          return;
        }
        // Trigger rebuild SSE.
        if (aborted) return;
        setPhase('rebuilding');
        abort = new AbortController();
        const r = await fetch(`/api/sessions/${sessionId}/memory/rebuild`, {
          method: 'POST',
          signal: abort.signal,
        });
        const reader = r.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const p of parts) {
            const ev = p.match(/^event: (.+)$/m)?.[1];
            const dataLine = p.match(/^data: (.+)$/m)?.[1];
            if (!ev || !dataLine) continue;
            const payload = JSON.parse(dataLine) as Progress | { reason?: string; message?: string };
            if (ev === 'chapter_done' && 'index' in payload) {
              setProgress(payload);
            } else if (ev === 'complete') {
              if (!aborted) {
                setPhase('done');
                onReady();
              }
              return;
            } else if (ev === 'error') {
              if (!aborted) {
                setPhase('error');
                setErrorMsg(
                  ('reason' in payload && payload.reason) ||
                    ('message' in payload && payload.message) ||
                    'unknown',
                );
              }
              return;
            }
          }
        }
      } catch (e) {
        if (!aborted) {
          setPhase('error');
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      aborted = true;
      abort?.abort();
    };
  }, [sessionId, onReady]);

  if (phase === 'checking' || phase === 'done') return null;
  if (phase === 'rebuilding') {
    const pct = progress && progress.total > 0 ? Math.floor((progress.index / progress.total) * 100) : 0;
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm">
        <div>Costruzione memoria della campagna in corso…</div>
        <div className="text-xs opacity-70">
          {progress ? `Capitolo ${progress.index + 1} di ${progress.total}` : 'Inizio…'} ({pct}%)
        </div>
      </div>
    );
  }
  // error
  return (
    <div className="rounded-md border border-red-500/40 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm">
      <div>Errore costruzione memoria: {errorMsg ?? 'unknown'}</div>
      <button
        type="button"
        className="mt-1 text-xs underline"
        onClick={() => window.location.reload()}
      >
        Riprova
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Mount the banner in the session chat page**

Open the session page identified in step 1. At the top of the chat, render:

```tsx
import { MemoryStatusBanner } from '@/components/memory-status-banner';

// inside the component, alongside existing state:
const [memoryReady, setMemoryReady] = useState(false);

// in JSX, above the chat history:
<MemoryStatusBanner sessionId={sessionId} onReady={() => setMemoryReady(true)} />

// when rendering the chat input, disable it while memory not ready:
<ChatInput disabled={!memoryReady} ... />
```

If the session has 0 messages, `needsBackfill: false` is returned immediately and `onReady` fires synchronously after the first `fetch` resolves — UX is essentially zero-flicker.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `pnpm typecheck && pnpm dev`

Open a session with 80+ messages. Expected:
- Banner appears at top.
- Progress text updates as chapters land.
- Banner disappears when complete.
- Chat input becomes enabled.

- [ ] **Step 5: Commit**

```bash
git add src/components/memory-status-banner.tsx <session-page-file>
git commit -m "feat(ui): memory status banner + chat-input gate during backfill"
```

---

## Task 17: Manual rebuild button in session settings

**Files:**
- Modify: the existing session settings UI (find via grep)

- [ ] **Step 1: Locate the session settings UI**

Run: `grep -rn "session.*settings\|preferences\|/settings" src/app src/components --include="*.tsx" -l | head -10`

Open the relevant settings/preferences component. Look for a place where session-level actions live (e.g. "Termina sessione" or similar).

- [ ] **Step 2: Add the rebuild button**

Add a button + confirm dialog. Example:

```tsx
'use client';

import { useState } from 'react';

export function RebuildMemoryButton({ sessionId }: { sessionId: string }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  const handleClick = (): void => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRunning(true);
    // Trigger rebuild — the banner on the session page will pick up via /memory/status next render.
    // But here we're in settings, so kick off the SSE and wait.
    fetch(`/api/sessions/${sessionId}/memory/rebuild`, { method: 'POST' })
      .then(async (r) => {
        const reader = r.body!.getReader();
        // Drain stream silently — banner UI handles user-visible progress on session page.
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      })
      .finally(() => {
        setRunning(false);
        setConfirming(false);
        // Notify the user; could route back to session page.
        window.location.reload();
      });
  };

  if (running) return <div className="text-sm">Ricostruzione in corso…</div>;
  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded bg-amber-600 px-3 py-1 text-sm text-white hover:bg-amber-700"
    >
      {confirming ? 'Confermi? Cancellerà tutta la memoria attuale e la rigenererà.' : 'Ricostruisci memoria'}
    </button>
  );
}
```

Mount it inside the existing session settings panel.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `pnpm typecheck && pnpm dev`. Click the button on a real session twice (once to confirm). Watch the network panel for the SSE call.

- [ ] **Step 4: Commit**

```bash
git add src/components/<path-to-button> <settings-file>
git commit -m "feat(ui): manual rebuild memory button in session settings"
```

---

## Task 18: E2E smoke test (Playwright)

**Files:**
- Create: `tests/e2e/memory-backfill.spec.ts`

- [ ] **Step 1: Look at existing e2e tests for the auth + session-creation pattern**

Run: `ls tests/e2e/`

Open one of the existing specs (e.g. `tests/e2e/<existing>.spec.ts`) to see the auth bypass pattern, base URL, and how sessions are seeded. Reuse the same setup helpers.

- [ ] **Step 2: Write the e2e test**

Skeleton (adapt to existing helpers):

```ts
// tests/e2e/memory-backfill.spec.ts
import { test, expect } from '@playwright/test';
import { db, pool } from '@/db/client';
import { sql } from 'drizzle-orm';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages } from '@/db/schema';

const TEST_USER = process.env.E2E_USER_ID ?? 'e2e_user';

test.describe('memory backfill', () => {
  let sessionId = '';
  test.beforeAll(async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'E2E';
    const c = await saveCharacter({ userId: TEST_USER, wizard: w });
    const [s] = await db
      .insert(sessions)
      .values({ userId: TEST_USER, characterId: c.id, premise: 'e2e' })
      .returning();
    sessionId = s!.id;
    await db.insert(sessionState).values({ sessionId, hpCurrent: 10, hitDiceRemaining: 1 });
    // Seed 80 messages
    const rows = [];
    for (let i = 0; i < 80; i++) {
      rows.push({
        sessionId,
        role: (i % 2 === 0 ? 'player' : 'master') as 'player' | 'master',
        content: `seeded message ${i}`,
      });
    }
    await db.insert(sessionMessages).values(rows);
  });

  test.afterAll(async () => {
    await db.execute(sql`delete from sessions where id = ${sessionId}`);
    await pool.end();
  });

  test('opens session, sees backfill banner, banner disappears on complete', async ({ page }) => {
    await page.goto(`/session/${sessionId}`);
    // Banner should be visible (we expect Italian copy from Task 16).
    await expect(page.getByText(/Costruzione memoria/i)).toBeVisible();
    // Wait up to 60 s for completion.
    await expect(page.getByText(/Costruzione memoria/i)).not.toBeVisible({ timeout: 60_000 });
    // Chat input is now enabled.
    const input = page.locator('textarea, [data-testid="chat-input"]').first();
    await expect(input).toBeEnabled();
  });
});
```

- [ ] **Step 3: Run e2e**

Run: `pnpm test:e2e tests/e2e/memory-backfill.spec.ts`
Expected: PASS.

If the URL pattern (`/session/<id>`) or input testid differs, adapt. If the banner copy differs, adapt the regex.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/memory-backfill.spec.ts
git commit -m "test(e2e): backfill banner appears and clears on session open"
```

---

## Task 19: Final integration smoke

**Files:** none (manual verification)

- [ ] **Step 1: Full test suite**

Run: `pnpm typecheck && pnpm vitest run && pnpm lint`
Expected: PASS, no warnings.

- [ ] **Step 2: Run dev and play a real campaign for ~5 turns on a fresh session**

```bash
pnpm dev
```

In another terminal, watch logs:

```bash
tail -f /tmp/dnd-ai-master.log  # or wherever dev logs go; use the dev terminal output
```

- Open a fresh session.
- Play 5-10 turns naming a clear NPC (e.g. "Aldric" or "il taverniere Garek") and a clear location ("Taverna del Cinghiale").
- Stop and run:

```bash
psql "$DATABASE_URL" -c "select kind, slug, name from codex_entities where session_id = '<session-id>' order by kind, slug"
```

Expected: at least an `npc` row for Aldric/Garek and a `location` row for the tavern.

- [ ] **Step 3: Trigger a chapter manually**

Continue playing until 40+ messages are in the session, OR seed more messages directly. Check:

```bash
psql "$DATABASE_URL" -c "select chapter_index, message_count, length(summary) from session_chapters where session_id = '<session-id>'"
```

Expected: at least one chapter row with `message_count = 40` and a non-empty summary.

- [ ] **Step 4: Sanity-check master coherence**

Refer back to a detail you established in turn 2. Verify that the master picks it up correctly even when the session is past 40+ messages. The fact should be in `chapterDigests` or in the codex.

- [ ] **Step 5: Final commit if anything was tweaked**

If you made any small fixes during step 4 (e.g. prompt tweaks), commit them. Otherwise no commit needed.

---

## Summary of commits when complete

1. `feat(db): session_chapters schema`
2. `feat(db): codex_entities schema with kind enum`
3. `feat(db): migration for session_chapters + codex_entities`
4. `feat(memory): patch + extractor types`
5. `feat(memory): applyPatch upserts codex entities and inserts chapter rows`
6. `feat(memory): extractor prompt + formatters`
7. `feat(memory): extractor with light/full modes and OOC filtering`
8. `feat(memory): loadMemoryContext + scene card selection`
9. `feat(tools): add lookup_codex tool definition`
10. `feat(tools): TOOL_HANDLERS_DB registry + lookup_codex handler`
11. `feat(tool-loop): two-tier dispatch with TOOL_HANDLERS_DB`
12. `feat(master): inject memory context blocks + memory tool rule`
13. `feat(turn): inject memory context + fire async extractor via waitUntil`
14. `feat(memory): GET /memory/status endpoint`
15. `feat(memory): POST /memory/rebuild SSE endpoint + rebuildMemoryStream`
16. `feat(ui): memory status banner + chat-input gate during backfill`
17. `feat(ui): manual rebuild memory button in session settings`
18. `test(e2e): backfill banner appears and clears on session open`

---

## Non-obvious details engineers may need

- **Drizzle `onConflictDoUpdate`** in Task 5 uses a multi-column conflict target `[sessionId, kind, slug]`. This relies on the `uniqueIndex` declared in Task 2 — if you forget that index, the upsert will fail.
- **Provider injection seam** (`__setExtractorProviderForTest`) parallels `__setOpenAIClientForTest` in `src/sessions/scene-image-job.ts`. Tests inject a fake; production reads from `getMasterProvider()`.
- **Advisory lock key**: `pg_try_advisory_lock(hashtextextended(sessionId, 0))`. Two-arg form yields a `bigint` that fits the lock API. Always pair `pg_try_advisory_lock` with `pg_advisory_unlock` in a `finally`.
- **OOC convention**: messages whose content (after trim) starts with `!` are meta-game. The convention was introduced in commit `7b26f4b`. The extractor MUST exclude them; the count for `messageCount` and `chapterCount` thresholds also excludes them.
- **`waitUntil` in turn route**: imported from `@vercel/functions`. Already used in `applicator.ts` for `queue_scene_image` (commit `54aadf6`) — same pattern.
- **Turn history limit stays at 20**: don't be tempted to raise it. Chapter digests carry the older context now.
- **`lookup_codex` is async** — that's why `runToolLoop` needs `await dbHandler(...)` (Task 11). Existing pure handlers stay sync.
- **`MEMORY_EXTRACTOR_MODEL` env var**: not required. When unset, falls back to the provider's default model. Document in `.env.example` if the project has one (check `ls -a` at repo root).
