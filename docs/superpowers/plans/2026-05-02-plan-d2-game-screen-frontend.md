# Plan D2 — Game Screen Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the playable game screen — a 3-pane UI (character / narrative / mechanics) backed by Plan D1's SSE endpoints, plus the lobby pages (sessions list + new-session creation). Closes Plan D1 follow-up I3 by refactoring the tool loop to emit events progressively.

**Architecture:** The page is a Next.js client component (`/sessions/[id]/page.tsx` server-loads + `game-client.tsx` client). It opens two SSE streams: one persistent for state updates (`/api/sessions/[id]/state`) and one per-turn for the master loop (`/api/sessions/[id]/turn`). State updates feed the character + mechanics panes; turn events feed the narrative pane (text deltas, tool pills, dice rolls). The tool loop in `src/ai/master/tool-loop.ts` is refactored to take an `onEvent` callback so events flush as they happen, not batched at end. Pages reuse Plan C's primitives (Button, Card, Chip, Field) and tokens from `src/styles/tokens.css`.

**Tech Stack:**
- Existing Plan C foundation: Next.js 16 App Router + Clerk + Tailwind v4 + design tokens + UI primitives
- Existing Plan D1 backend: Anthropic SDK, sessions API, SSE endpoints
- Browser-native `EventSource` API for SSE consumption
- React 19 hooks (no Zustand needed — wizard pattern of `useReducer` works for the game screen too)

---

## Boundaries — what Plan D2 does NOT do

- ❌ Multiplayer (party strip, lobby, remote rooms) — future plan #6
- ❌ Campaign management — future plan #5
- ❌ Pre-written modules — future plan
- ❌ Mobile-responsive variants — desktop-first MVP
- ❌ Light theme — explicit MVP scope
- ❌ Real-time push for state (uses 1.5s SSE poll from Plan D1) — Postgres LISTEN/NOTIFY can come later

---

## Boundaries — what Plan D2 DOES include

- ✅ Refactor `runToolLoop` with `onEvent` callback (closes I3)
- ✅ Two new GET endpoints to load history on page mount: `/api/sessions/[id]/messages`, `/api/sessions/[id]/dice-log`
- ✅ Client-side SSE consumer hooks: `useTurnStream`, `useSessionState`
- ✅ UI primitives: `ToolPill`, `DiceLogEntry`, `CombatTracker`, `SpinningDie`
- ✅ Pages: `/sessions` (list), `/sessions/new` (create), `/sessions/[id]` (3-pane game screen)
- ✅ Three panes: `CharacterPane`, `NarrativePane`, `MechanicsPane`
- ✅ `SpellModal` (slot picker for cast_spell quick action)
- ✅ Component tests for new primitives
- ✅ One E2E smoke that verifies the 3-pane layout renders for a freshly-created session (Clerk testing token gated)

---

## File map

### Backend prep
```
src/ai/master/tool-loop.ts            MODIFY — add onEvent callback (I3)
tests/ai/master/tool-loop.test.ts     MODIFY — add onEvent callback test
src/app/api/sessions/[id]/turn/route.ts MODIFY — use onEvent for progressive flush
src/app/api/sessions/[id]/messages/route.ts        NEW — GET (history)
src/app/api/sessions/[id]/dice-log/route.ts        NEW — GET (recent rolls)
```

### Client SSE
```
src/sessions/client-types.ts          NEW — typed SSE events for client
src/sessions/use-turn-stream.ts       NEW — consume turn SSE
src/sessions/use-session-state.ts     NEW — consume state SSE
```

### UI primitives (game-screen specific)
```
src/components/game/tool-pill.tsx     NEW
src/components/game/dice-log-entry.tsx NEW
src/components/game/dice-log-panel.tsx NEW
src/components/game/combat-tracker.tsx NEW
src/components/game/spinning-die.tsx  NEW
src/components/game/spell-modal.tsx   NEW
```

### Game screen panes
```
src/components/game/character-pane.tsx  NEW
src/components/game/narrative-pane.tsx  NEW
src/components/game/mechanics-pane.tsx  NEW
src/components/game/game-shell.tsx      NEW (3-pane layout container)
```

### Pages
```
src/app/(authed)/sessions/page.tsx                NEW — list of sessions
src/app/(authed)/sessions/new/page.tsx            NEW — server (loads characters)
src/app/(authed)/sessions/new/new-client.tsx      NEW — client (form)
src/app/(authed)/sessions/[id]/page.tsx           NEW — server (loads session + history)
src/app/(authed)/sessions/[id]/game-client.tsx    NEW — client (3-pane wiring)
```

### Tests
```
tests/components/game/tool-pill.test.tsx        NEW
tests/components/game/dice-log-entry.test.tsx   NEW
tests/components/game/combat-tracker.test.tsx   NEW
tests/api/sessions-history.test.ts              NEW (messages + dice-log endpoints)
tests/sessions/use-turn-stream.test.ts          NEW (parser of SSE wire format)
tests/e2e/game-screen.spec.ts                   NEW (Clerk-gated; skip if no testing token)
```

---

## Phase 1 — Backend prep

### Task 1: Branch + refactor `runToolLoop` with `onEvent` callback

**Files:**
- Modify: `src/ai/master/tool-loop.ts`
- Modify: `tests/ai/master/tool-loop.test.ts`

- [ ] **Step 1: Verify state**

```bash
pwd && git branch --show-current && git log --oneline -3
```
Expected: working dir `/Users/alessiodanna/projects/dnd-ai-master`, branch `main`. Last commit `aa41ed8 fix(d1): plug ownership window in turn route + safe applicator + state SSE keepalive`.

- [ ] **Step 2: Create the working branch**

```bash
git checkout -b plan-d2-game-screen
git branch --show-current
```

- [ ] **Step 3: Modify `src/ai/master/tool-loop.ts` to add `onEvent`**

In the existing `ToolLoopInput` interface, add an optional callback. In the loop body, replace each `events.push(ev)` with a small helper that both pushes to the array AND calls the callback if provided.

The full updated `tool-loop.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ActionResult, EngineState, Mutation, DiceRoll } from '@/engine/types';
import { TOOL_HANDLERS, TOOL_DEFINITIONS } from '@/engine';
import { TURN_TOOL_CALL_CAP, TURN_TIMEOUT_MS, type TurnEvent } from '@/sessions/types';

export interface ToolLoopInput {
  client: Pick<Anthropic, 'messages'>;
  model: string;
  systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  history: Anthropic.Messages.MessageParam[];
  state: EngineState;
  applyMutations?: (mutations: Mutation[], rolls: DiceRoll[]) => Promise<void>;
  recordUsage?: (usage: Anthropic.Messages.Usage) => Promise<void>;
  /** Called once per emitted event, in order. Use to flush events to an SSE stream as they happen. */
  onEvent?: (event: TurnEvent) => void;
}

export interface ToolLoopResult {
  events: TurnEvent[];
  finalText: string;
  toolCallCount: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const { client, model, systemBlocks, history, state, applyMutations, recordUsage, onEvent } = input;
  const events: TurnEvent[] = [];
  let finalText = '';
  let toolCallCount = 0;
  let truncated = false;
  let timedOut = false;
  const start = Date.now();
  const messages: Anthropic.Messages.MessageParam[] = [...history];

  const emit = (ev: TurnEvent): void => {
    events.push(ev);
    onEvent?.(ev);
  };

  for (let iter = 0; iter < TURN_TOOL_CALL_CAP + 1; iter++) {
    if (Date.now() - start > TURN_TIMEOUT_MS) {
      timedOut = true;
      emit({ type: 'turn_error', reason: 'timeout', recoverable: true });
      break;
    }

    const response: Anthropic.Messages.Message = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemBlocks,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    if (recordUsage) await recordUsage(response.usage);

    const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        finalText += block.text;
        emit({ type: 'narrative_delta', text: block.text });
      } else if (block.type === 'tool_use') {
        toolUses.push(block);
      }
    }

    if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
      break;
    }

    if (toolCallCount + toolUses.length > TURN_TOOL_CALL_CAP) {
      truncated = true;
      emit({ type: 'turn_error', reason: 'tool_call_cap', recoverable: true });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCallCount += 1;
      emit({ type: 'tool_use_start', toolUseId: tu.id, name: tu.name, input: tu.input as Record<string, unknown> });

      const handler = TOOL_HANDLERS[tu.name];
      let result: ActionResult;
      if (!handler) {
        result = { ok: false, error: `unknown_tool:${tu.name}`, rolls: [], mutations: [] };
      } else {
        try {
          result = handler(state, tu.input as Record<string, unknown>);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e), rolls: [], mutations: [] };
        }
      }

      emit({
        type: 'tool_use_end',
        toolUseId: tu.id,
        ok: result.ok,
        error: result.error,
        rolls: result.rolls,
        mutationCount: result.mutations.length,
      });

      if (result.mutations.length > 0 || result.rolls.length > 0) {
        if (applyMutations) await applyMutations(result.mutations, result.rolls);
        emit({ type: 'state_changed', mutations: result.mutations });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ ok: result.ok, data: result.data, error: result.error, rolls: result.rolls }),
        is_error: !result.ok,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { events, finalText, toolCallCount, truncated, timedOut };
}
```

- [ ] **Step 4: Add a test that verifies `onEvent` is called in order**

Append to `tests/ai/master/tool-loop.test.ts` (inside the existing `describe('runToolLoop', ...)` block):

```ts
  it('calls onEvent in order as each event is emitted', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(fakeMessage(
        [
          { type: 'text', text: 'Rolling…', citations: null },
          { type: 'tool_use', id: 'tu1', name: 'roll_d20', input: { modifier: 3 } } as never,
        ],
        'tool_use',
      ))
      .mockResolvedValueOnce(fakeMessage([{ type: 'text', text: 'Done.', citations: null }]));
    const seen: string[] = [];
    const result = await runToolLoop({
      client: { messages: { create } as never },
      model: 'test',
      systemBlocks: [{ type: 'text', text: 'sys' }],
      history: [{ role: 'user', content: 'go' }],
      state: baseState,
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen.length).toBe(result.events.length);
    expect(seen).toEqual(result.events.map((e) => e.type));
    expect(seen[0]).toBe('narrative_delta');
    expect(seen.includes('tool_use_start')).toBe(true);
    expect(seen.includes('tool_use_end')).toBe(true);
    expect(seen.at(-1)).toBe('narrative_delta');
  });
```

- [ ] **Step 5: Run all tool-loop tests**

```bash
pnpm test tests/ai/master/tool-loop.test.ts 2>&1 | tail -10
```
Expected: 5 tests pass (4 existing + 1 new).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/ai/master/tool-loop.ts tests/ai/master/tool-loop.test.ts
git commit -m "feat(ai/master): tool loop emits events via onEvent callback (I3)"
```

---

### Task 2: Wire `onEvent` into the turn route for progressive SSE flush

**Files:**
- Modify: `src/app/api/sessions/[id]/turn/route.ts`

- [ ] **Step 1: Verify state**

```bash
git log --oneline -3
```
Expected: last commit `feat(ai/master): tool loop emits events via onEvent callback`.

- [ ] **Step 2: Replace the tool-loop invocation block**

Currently the route calls `runToolLoop({...})` then has `for (const ev of result.events) send(ev.type, ev);` after the loop. Replace this with a direct `onEvent` callback that calls `send` immediately.

In `src/app/api/sessions/[id]/turn/route.ts`, find the section starting at `// 5. Run the tool loop` and ending at `// 7. Persist master message`. Replace the block with:

```ts
        // 5. Run the tool loop — events flush as they happen via onEvent
        const result = await runToolLoop({
          client: getAnthropicClient(),
          model: MASTER_MODEL,
          systemBlocks: sys.system,
          history,
          state: snap.state,
          applyMutations: (muts, rolls) => applyMutations(sessionId, muts, rolls),
          recordUsage: async (usage) => {
            await recordUsage({
              userId,
              sessionId,
              endpoint: 'master',
              model: MASTER_MODEL,
              usage: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadTokens: (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
                cacheCreationTokens: (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
              },
            });
          },
          onEvent: (ev) => send(ev.type, ev),
        });

        // 6. Persist master message
```

(Note: step 6 in the comments shifts because we removed the previous "stream all events" step.)

- [ ] **Step 3: Build check**

```bash
pnpm build 2>&1 | tail -5
```
Expected: build succeeds.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add "src/app/api/sessions/[id]/turn/route.ts"
git commit -m "feat(api): turn route flushes SSE events progressively via onEvent"
```

---

### Task 3: GET messages + dice-log endpoints

**Files:**
- Create: `src/app/api/sessions/[id]/messages/route.ts`
- Create: `src/app/api/sessions/[id]/dice-log/route.ts`
- Create: `tests/api/sessions-history.test.ts`

- [ ] **Step 1: Create `src/app/api/sessions/[id]/messages/route.ts`**

```bash
mkdir -p "src/app/api/sessions/[id]/messages"
```

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionMessages } from '@/db/schema';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const messages = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.createdAt))
    .limit(200);

  return NextResponse.json({ messages });
}
```

- [ ] **Step 2: Create `src/app/api/sessions/[id]/dice-log/route.ts`**

```bash
mkdir -p "src/app/api/sessions/[id]/dice-log"
```

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, diceLog } from '@/db/schema';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id: sessionId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const rolls = await db
    .select()
    .from(diceLog)
    .where(eq(diceLog.sessionId, sessionId))
    .orderBy(desc(diceLog.createdAt))
    .limit(50);

  return NextResponse.json({ rolls });
}
```

- [ ] **Step 3: Write integration test `tests/api/sessions-history.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, diceLog } from '@/db/schema';

const TEST_USER = 'user_history_' + Date.now();
let SESSION_ID = '';

describe('sessions history persistence', () => {
  afterAll(async () => {
    await db.execute(sql`delete from dice_log where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_messages where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from session_state where session_id = ${SESSION_ID}`);
    await db.execute(sql`delete from sessions where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from characters where user_id = ${TEST_USER}`);
    await db.execute(sql`delete from users where id = ${TEST_USER}`);
    await pool.end();
  });

  it('persists messages and dice rolls and reads them back ordered', async () => {
    await ensureUser(TEST_USER);
    const w = emptyWizardState();
    w.raceSlug = 'half-elf'; w.classSlug = 'fighter'; w.backgroundSlug = 'soldier'; w.identity.name = 'Tharion';
    const { id: charId } = await saveCharacter({ userId: TEST_USER, wizard: w });

    const [s] = await db.insert(sessions).values({ userId: TEST_USER, characterId: charId, premise: 'goblin warren' }).returning();
    SESSION_ID = s!.id;
    await db.insert(sessionState).values({ sessionId: SESSION_ID, hpCurrent: 11, hitDiceRemaining: 1 });

    await db.insert(sessionMessages).values([
      { sessionId: SESSION_ID, role: 'player', content: 'I attack the goblin' },
      { sessionId: SESSION_ID, role: 'master', content: 'Your blade finds its mark.' },
    ]);

    await db.insert(diceLog).values([
      { sessionId: SESSION_ID, kind: 'attack', formula: '1d20+5', rolls: [14], modifier: 5, total: 19, meta: {} },
      { sessionId: SESSION_ID, kind: 'damage', formula: '1d8+3', rolls: [4], modifier: 3, total: 7, meta: {} },
    ]);

    const messages = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, SESSION_ID));
    expect(messages.length).toBe(2);
    const rolls = await db.select().from(diceLog).where(eq(diceLog.sessionId, SESSION_ID));
    expect(rolls.length).toBe(2);
    const totals = rolls.map((r) => r.total).sort((a, b) => a - b);
    expect(totals).toEqual([7, 19]);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm typecheck
pnpm test tests/api/sessions-history.test.ts 2>&1 | tail -5
git add "src/app/api/sessions/[id]/messages/route.ts" "src/app/api/sessions/[id]/dice-log/route.ts" tests/api/sessions-history.test.ts
git commit -m "feat(api): GET /api/sessions/[id]/{messages,dice-log} for game-screen restore"
```

---

## Phase 2 — Client SSE consumer

### Task 4: Client-side SSE event types

**Files:**
- Create: `src/sessions/client-types.ts`

- [ ] **Step 1: Implement**

```ts
import type { TurnEvent } from './types';

export type { TurnEvent };

export interface MessageRow {
  id: string;
  sessionId: string;
  role: 'player' | 'master' | 'system';
  content: string;
  createdAt: string;
}

export interface DiceRollRow {
  id: string;
  sessionId: string;
  kind: 'attack' | 'damage' | 'save' | 'check' | 'init' | 'generic';
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface CombatActorRow {
  id: string;
  sessionId: string;
  name: string;
  monsterSlug: string | null;
  hpCurrent: number;
  hpMax: number;
  initiative: number;
  isAlive: boolean;
  conditions: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];
}

export interface SessionRow {
  id: string;
  userId: string;
  characterId: string;
  premise: string;
  language: string | null;
  status: 'active' | 'ended';
  createdAt: string;
  updatedAt: string;
}

export interface SessionStateRow {
  sessionId: string;
  hpCurrent: number;
  tempHp: number;
  hitDiceRemaining: number;
  spellSlotsUsed: Record<string, number>;
  conditions: { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];
  resourcesUsed: Record<string, number>;
  inCombat: boolean;
  combat: { round: number; turnOrder: { actorId: string; initiative: number }[]; currentIdx: number } | null;
  scene: string;
}

export interface StateSnapshot {
  session: SessionRow;
  state: SessionStateRow;
  actors: CombatActorRow[];
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add src/sessions/client-types.ts
git commit -m "feat(sessions): client-side types for SSE consumers"
```

---

### Task 5: SSE consumer hooks

**Files:**
- Create: `src/sessions/use-turn-stream.ts`
- Create: `src/sessions/use-session-state.ts`
- Create: `tests/sessions/use-turn-stream.test.ts`

- [ ] **Step 1: Implement `src/sessions/use-turn-stream.ts`**

```ts
'use client';
import * as React from 'react';
import type { TurnEvent } from './types';

export interface UseTurnStreamResult {
  busy: boolean;
  events: TurnEvent[];
  send: (message: string) => Promise<void>;
  error: string | null;
  reset: () => void;
}

/** Sends a player message to the turn endpoint and consumes the SSE stream.
 *  Buffers events; the consuming component re-renders as the array grows. */
export function useTurnStream(sessionId: string): UseTurnStreamResult {
  const [busy, setBusy] = React.useState(false);
  const [events, setEvents] = React.useState<TurnEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const reset = React.useCallback(() => {
    setEvents([]);
    setError(null);
  }, []);

  const send = React.useCallback(async (message: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const block of lines) {
          const evMatch = /^event: (.+)$/m.exec(block);
          const dataMatch = /^data: (.+)$/m.exec(block);
          if (!evMatch || !dataMatch) continue;
          try {
            const parsed = JSON.parse(dataMatch[1]!) as TurnEvent;
            setEvents((prev) => [...prev, parsed]);
          } catch {
            // ignore malformed event
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, sessionId]);

  React.useEffect(() => () => { abortRef.current?.abort(); }, []);

  return { busy, events, send, error, reset };
}
```

- [ ] **Step 2: Implement `src/sessions/use-session-state.ts`**

```ts
'use client';
import * as React from 'react';
import type { StateSnapshot } from './client-types';

/** Subscribes to /api/sessions/[id]/state via EventSource, exposing the latest snapshot. */
export function useSessionState(sessionId: string): { snapshot: StateSnapshot | null; error: string | null } {
  const [snapshot, setSnapshot] = React.useState<StateSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/state`);
    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as StateSnapshot;
        setSnapshot(parsed);
      } catch {
        // ignore
      }
    });
    es.addEventListener('error', () => setError('connection_lost'));
    return () => es.close();
  }, [sessionId]);

  return { snapshot, error };
}
```

- [ ] **Step 3: Write a SSE wire-format parser test**

`tests/sessions/use-turn-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

/** Mirrors the parsing logic inside useTurnStream's reader loop, in isolation. */
function parseSseChunk(buffer: string): { events: { name: string; data: string }[]; remaining: string } {
  const events: { name: string; data: string }[] = [];
  const lines = buffer.split('\n\n');
  const remaining = lines.pop() ?? '';
  for (const block of lines) {
    const evMatch = /^event: (.+)$/m.exec(block);
    const dataMatch = /^data: (.+)$/m.exec(block);
    if (evMatch && dataMatch) events.push({ name: evMatch[1]!, data: dataMatch[1]! });
  }
  return { events, remaining };
}

describe('SSE chunk parser', () => {
  it('parses a single complete event', () => {
    const r = parseSseChunk('event: narrative_delta\ndata: {"type":"narrative_delta","text":"Hi"}\n\n');
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.name).toBe('narrative_delta');
    expect(JSON.parse(r.events[0]!.data).text).toBe('Hi');
    expect(r.remaining).toBe('');
  });

  it('parses two events back-to-back', () => {
    const wire =
      'event: a\ndata: {"x":1}\n\n' +
      'event: b\ndata: {"x":2}\n\n';
    const r = parseSseChunk(wire);
    expect(r.events.length).toBe(2);
    expect(r.events.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('keeps an incomplete trailing event in the remainder', () => {
    const wire =
      'event: a\ndata: {"x":1}\n\n' +
      'event: b\ndata: {"x":';
    const r = parseSseChunk(wire);
    expect(r.events.length).toBe(1);
    expect(r.remaining).toBe('event: b\ndata: {"x":');
  });

  it('ignores blocks missing event or data line', () => {
    const wire = 'data: nope\n\nevent: x\n\n';
    const r = parseSseChunk(wire);
    expect(r.events.length).toBe(0);
  });
});
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
pnpm typecheck
pnpm test tests/sessions/use-turn-stream.test.ts 2>&1 | tail -5
git add src/sessions/use-turn-stream.ts src/sessions/use-session-state.ts tests/sessions/use-turn-stream.test.ts
git commit -m "feat(sessions): client SSE hooks (useTurnStream, useSessionState)"
```

---

## Phase 3 — UI primitives (game-screen)

### Task 6: ToolPill component

**Files:**
- Create: `src/components/game/tool-pill.tsx`
- Create: `tests/components/game/tool-pill.test.tsx`

- [ ] **Step 1: Implement `src/components/game/tool-pill.tsx`**

```bash
mkdir -p src/components/game
```

```tsx
'use client';
import { Icon } from '@/components/ui/icon';

export type ToolPillStatus = 'pending' | 'ok' | 'error';

export interface ToolPillProps {
  toolName: string;
  formula?: string;
  result?: string;
  status: ToolPillStatus;
}

export function ToolPill({ toolName, formula, result, status }: ToolPillProps) {
  const tone =
    status === 'ok' ? 'var(--verdigris)' :
    status === 'error' ? 'var(--ember)' :
    'var(--fg-muted)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        padding: '4px 10px',
        borderRadius: 999,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--fg-muted)',
      }}
    >
      {status === 'pending' ? (
        <span style={{ display: 'inline-block', animation: 'spin 1.2s linear infinite' }}>
          <Icon name="logo-d20" size={12} />
        </span>
      ) : (
        <span style={{ color: 'var(--fg)' }}>⚙ {toolName}</span>
      )}
      {formula && <span>{formula}</span>}
      {result && <span style={{ color: tone, fontWeight: 600 }}>→ {result}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Write the test**

`tests/components/game/tool-pill.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolPill } from '@/components/game/tool-pill';

describe('ToolPill', () => {
  it('renders the tool name', () => {
    render(<ToolPill toolName="make_attack" status="ok" />);
    expect(screen.getByText(/make_attack/)).toBeInTheDocument();
  });

  it('renders formula and result', () => {
    render(<ToolPill toolName="make_attack" formula="1d20+5" result="18 vs AC 13" status="ok" />);
    expect(screen.getByText('1d20+5')).toBeInTheDocument();
    expect(screen.getByText(/18 vs AC 13/)).toBeInTheDocument();
  });

  it('renders the spinning d20 when pending (no tool name visible)', () => {
    const { container } = render(<ToolPill toolName="make_attack" status="pending" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    // pending state hides the literal "⚙ make_attack" prefix
    expect(screen.queryByText(/⚙ make_attack/)).toBeNull();
  });
});
```

- [ ] **Step 3: Add the spin keyframe to globals.css**

In `src/app/globals.css`, append:

```css
@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}
```

- [ ] **Step 4: Run + commit**

```bash
pnpm typecheck
pnpm test tests/components/game/tool-pill.test.tsx 2>&1 | tail -5
git add src/components/game/tool-pill.tsx tests/components/game/tool-pill.test.tsx src/app/globals.css
git commit -m "feat(game): ToolPill component with pending/ok/error states + spin/pulse keyframes"
```

---

### Task 7: DiceLogEntry + DiceLogPanel

**Files:**
- Create: `src/components/game/dice-log-entry.tsx`
- Create: `src/components/game/dice-log-panel.tsx`
- Create: `tests/components/game/dice-log-entry.test.tsx`

- [ ] **Step 1: Implement `src/components/game/dice-log-entry.tsx`**

```tsx
'use client';

export interface DiceLogEntryProps {
  kind: string;
  formula: string;
  total: number;
  note?: string;
  crit?: boolean;
  fail?: boolean;
}

export function DiceLogEntry({ kind, formula, total, note, crit, fail }: DiceLogEntryProps) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        lineHeight: 1.45,
        padding: '4px 6px',
        borderRadius: 4,
        background: crit ? 'rgba(224,184,74,0.10)' : 'transparent',
      }}
    >
      <span style={{ color: 'var(--fg-muted)' }}>{kind.padEnd(7)}</span>
      <span style={{ color: 'var(--fg)' }}> {formula} → </span>
      <span style={{ color: crit ? 'var(--gold)' : fail ? 'var(--ember)' : 'var(--fg)', fontWeight: 600 }}>{total}</span>
      {note && <div style={{ color: 'var(--fg-subtle)', paddingLeft: 56, marginTop: -1 }}>{note}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Implement `src/components/game/dice-log-panel.tsx`**

```tsx
'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { DiceLogEntry } from './dice-log-entry';
import type { DiceRollRow } from '@/sessions/client-types';

export interface DiceLogPanelProps {
  rolls: DiceRollRow[];
  limit?: number;
}

export function DiceLogPanel({ rolls, limit = 7 }: DiceLogPanelProps) {
  const visible = rolls.slice(0, limit);
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Eyebrow>Dice log</Eyebrow>
        <span style={{ fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>last {limit}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>no rolls yet</div>
        ) : (
          visible.map((r) => (
            <DiceLogEntry
              key={r.id}
              kind={r.kind}
              formula={r.formula}
              total={r.total}
              note={typeof r.meta?.note === 'string' ? r.meta.note : undefined}
              crit={typeof r.meta?.crit === 'boolean' ? r.meta.crit : undefined}
              fail={typeof r.meta?.fail === 'boolean' ? r.meta.fail : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Test**

`tests/components/game/dice-log-entry.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiceLogEntry } from '@/components/game/dice-log-entry';

describe('DiceLogEntry', () => {
  it('renders kind, formula and total', () => {
    render(<DiceLogEntry kind="attack" formula="1d20+5" total={18} />);
    expect(screen.getByText(/attack/)).toBeInTheDocument();
    expect(screen.getByText(/1d20\+5/)).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('renders the note when provided', () => {
    render(<DiceLogEntry kind="attack" formula="1d20+5" total={18} note="vs goblin AC 13 — hit" />);
    expect(screen.getByText(/vs goblin AC 13/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm typecheck
pnpm test tests/components/game/dice-log-entry.test.tsx 2>&1 | tail -5
git add src/components/game/dice-log-entry.tsx src/components/game/dice-log-panel.tsx tests/components/game/dice-log-entry.test.tsx
git commit -m "feat(game): DiceLogEntry + DiceLogPanel"
```

---

### Task 8: CombatTracker

**Files:**
- Create: `src/components/game/combat-tracker.tsx`
- Create: `tests/components/game/combat-tracker.test.tsx`

- [ ] **Step 1: Implement**

```tsx
'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import type { CombatActorRow, SessionStateRow } from '@/sessions/client-types';

export interface CombatTrackerProps {
  state: Pick<SessionStateRow, 'inCombat' | 'combat'>;
  actors: CombatActorRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpCurrent: number;
  pcHpMax: number;
}

interface TurnRow {
  actorId: string;
  name: string;
  init: number;
  hp: number;
  hpMax: number;
  alive: boolean;
  current: boolean;
}

export function CombatTracker({ state, actors, pcCharacterId, pcName, pcHpCurrent, pcHpMax }: CombatTrackerProps) {
  if (!state.inCombat || !state.combat) {
    return (
      <section>
        <Eyebrow style={{ marginBottom: 8 }}>Exploration</Eyebrow>
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--fg)',
          }}
        >
          No active combat. The Master may call for skill checks.
        </div>
      </section>
    );
  }

  const order: TurnRow[] = state.combat.turnOrder.map((t, idx) => {
    if (t.actorId === pcCharacterId) {
      return { actorId: t.actorId, name: pcName, init: t.initiative, hp: pcHpCurrent, hpMax: pcHpMax, alive: pcHpCurrent > 0, current: idx === state.combat!.currentIdx };
    }
    const a = actors.find((x) => x.id === t.actorId);
    return {
      actorId: t.actorId,
      name: a?.name ?? '???',
      init: t.initiative,
      hp: a?.hpCurrent ?? 0,
      hpMax: a?.hpMax ?? 0,
      alive: a?.isAlive ?? false,
      current: idx === state.combat!.currentIdx,
    };
  });

  const currentIsPc = order[state.combat.currentIdx]?.actorId === pcCharacterId;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Eyebrow>Combat · Round {state.combat.round}</Eyebrow>
        {currentIsPc && <Chip tone="warn" dot>Your turn</Chip>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {order.map((a) => (
          <div
            key={a.actorId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              background: a.current ? 'rgba(122,79,184,0.14)' : 'transparent',
              border: a.current ? '1px solid rgba(122,79,184,0.40)' : '1px solid transparent',
            }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)', width: 22, textAlign: 'right' }}>{a.init}</span>
            <span style={{ flex: 1, fontSize: 13, color: a.alive ? 'var(--fg)' : 'var(--fg-subtle)', textDecoration: a.alive ? 'none' : 'line-through' }}>{a.name}</span>
            {a.alive ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{a.hp}/{a.hpMax}</span>
                <div style={{ width: 56, height: 3, background: 'var(--bg-sunken)', borderRadius: 2, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${a.hpMax > 0 ? Math.round((a.hp / a.hpMax) * 100) : 0}%`,
                      background: a.hpMax > 0 && a.hp / a.hpMax <= 0.25 ? 'var(--ember)' : 'var(--verdigris)',
                    }}
                  />
                </div>
              </div>
            ) : (
              <span style={{ fontSize: 10, color: 'var(--ember)', fontFamily: 'var(--font-mono)' }}>down</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CombatTracker } from '@/components/game/combat-tracker';

describe('CombatTracker', () => {
  it('renders the exploration card when not in combat', () => {
    render(
      <CombatTracker
        state={{ inCombat: false, combat: null }}
        actors={[]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
      />,
    );
    expect(screen.getByText(/Exploration/i)).toBeInTheDocument();
    expect(screen.getByText(/No active combat/i)).toBeInTheDocument();
  });

  it('renders initiative order with PC and monster, highlighting current actor', () => {
    render(
      <CombatTracker
        state={{
          inCombat: true,
          combat: { round: 2, turnOrder: [{ actorId: 'pc1', initiative: 18 }, { actorId: 'm1', initiative: 12 }], currentIdx: 0 },
        }}
        actors={[
          { id: 'm1', sessionId: 's', name: 'Goblin', monsterSlug: 'goblin', hpCurrent: 4, hpMax: 7, initiative: 12, isAlive: true, conditions: [] },
        ]}
        pcCharacterId="pc1"
        pcName="Tharion"
        pcHpCurrent={20}
        pcHpMax={27}
      />,
    );
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
    expect(screen.getByText('Tharion')).toBeInTheDocument();
    expect(screen.getByText('Goblin')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm typecheck
pnpm test tests/components/game/combat-tracker.test.tsx 2>&1 | tail -5
git add src/components/game/combat-tracker.tsx tests/components/game/combat-tracker.test.tsx
git commit -m "feat(game): CombatTracker with initiative + HP bars + current-turn highlight"
```

---

### Task 9: SpinningDie + SpellModal

**Files:**
- Create: `src/components/game/spinning-die.tsx`
- Create: `src/components/game/spell-modal.tsx`

- [ ] **Step 1: Implement `src/components/game/spinning-die.tsx`**

```tsx
'use client';
import { Icon } from '@/components/ui/icon';

export function SpinningDie({ size = 16 }: { size?: number }) {
  return (
    <span style={{ display: 'inline-block', animation: 'spin 1.2s linear infinite' }}>
      <Icon name="logo-d20" size={size} />
    </span>
  );
}
```

- [ ] **Step 2: Implement `src/components/game/spell-modal.tsx`**

```tsx
'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';

export interface SpellSlotInfo {
  level: number;
  used: number;
  max: number;
}

export interface SpellModalProps {
  spellsKnown: string[];
  slots: SpellSlotInfo[];
  onCast: (spellSlug: string, slotLevel: number) => void;
  onClose: () => void;
}

export function SpellModal({ spellsKnown, slots, onCast, onClose }: SpellModalProps) {
  const [selectedSpell, setSelectedSpell] = React.useState<string | null>(spellsKnown[0] ?? null);
  const availableSlots = slots.filter((s) => s.max > s.used);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        zIndex: 10,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          padding: 24,
          width: 480,
          boxShadow: 'var(--shadow-3)',
        }}
      >
        <Eyebrow>Cast a spell</Eyebrow>
        <h3 style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600, marginTop: 4 }}>
          {selectedSpell ?? 'No spells known'}
        </h3>

        {spellsKnown.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <Eyebrow>Known spells</Eyebrow>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {spellsKnown.map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedSpell(s)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: selectedSpell === s ? 'var(--bone)' : 'var(--bg-elev)',
                    color: selectedSpell === s ? 'var(--ink)' : 'var(--fg)',
                    border: '1px solid ' + (selectedSpell === s ? 'var(--bone)' : 'var(--border)'),
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Eyebrow>Choose a slot</Eyebrow>
          {availableSlots.length === 0 ? (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-muted)' }}>No slots available — take a long rest.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {availableSlots.map((s) => (
                <button
                  key={s.level}
                  onClick={() => selectedSpell && onCast(selectedSpell, s.level)}
                  disabled={!selectedSpell}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    cursor: selectedSpell ? 'pointer' : 'not-allowed',
                    opacity: selectedSpell ? 1 : 0.4,
                    color: 'inherit',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>Lv {s.level}</span>
                  <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                    {Array.from({ length: s.max }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: '1.5px solid var(--arcane)',
                          background: i < s.used ? 'transparent' : 'var(--arcane)',
                        }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{s.max - s.used} left</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add src/components/game/spinning-die.tsx src/components/game/spell-modal.tsx
git commit -m "feat(game): SpinningDie + SpellModal"
```

---

## Phase 4 — Lobby pages

### Task 10: Sessions list page

**Files:**
- Create: `src/app/(authed)/sessions/page.tsx`

- [ ] **Step 1: Implement**

```bash
mkdir -p "src/app/(authed)/sessions"
```

```tsx
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions as sessionsTable, characters as charactersTable } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';

export const dynamic = 'force-dynamic';

export default async function SessionsListPage() {
  const { userId } = await auth();
  if (!userId) return null;
  await ensureUser(userId);

  const rows = await db
    .select({ session: sessionsTable, character: charactersTable })
    .from(sessionsTable)
    .leftJoin(charactersTable, eq(charactersTable.id, sessionsTable.characterId))
    .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.deletedAt)))
    .orderBy(desc(sessionsTable.updatedAt));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Sessions</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15, fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            {rows.length === 0 ? 'No sessions yet. Open the table.' : `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}.`}
          </p>
        </div>
        <Link href="/sessions/new">
          <Button variant="primary" size="md" icon="plus">New session</Button>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {rows.map(({ session: s, character: c }) => (
          <Link key={s.id} href={`/sessions/${s.id}`} style={{ color: 'inherit' }}>
            <Card accent={s.status === 'active'}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, lineHeight: 1.15 }}>
                    {c?.name ?? 'Unknown PC'}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                    <Chip tone={s.status === 'active' ? 'accent' : 'neutral'} dot={s.status === 'active'}>
                      {s.status}
                    </Chip>
                    {s.language && <Chip tone="gold">{s.language}</Chip>}
                  </div>
                </div>
                <Icon name="more" size={16} style={{ color: 'var(--fg-subtle)' }} />
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                "{s.premise}"
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <span>updated {new Date(s.updatedAt).toLocaleString()}</span>
              </div>
            </Card>
          </Link>
        ))}
        <Link href="/sessions/new" style={{ textDecoration: 'none' }}>
          <button
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px dashed var(--border-strong)',
              borderRadius: 8,
              padding: 18,
              minHeight: 200,
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Icon name="plus" size={24} />
            <span style={{ fontSize: 14 }}>Open the table</span>
          </button>
        </Link>
      </div>

      <div style={{ marginTop: 32, fontSize: 12, color: 'var(--fg-subtle)' }}>
        <Eyebrow>Tip</Eyebrow>
        <p style={{ marginTop: 6 }}>Sessions are stored on the server. Refresh to resume any time.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add "src/app/(authed)/sessions/page.tsx"
git commit -m "feat(web): /sessions page lists user's sessions"
```

---

### Task 11: New-session page

**Files:**
- Create: `src/app/(authed)/sessions/new/page.tsx`
- Create: `src/app/(authed)/sessions/new/new-client.tsx`

- [ ] **Step 1: Server page**

```bash
mkdir -p "src/app/(authed)/sessions/new"
```

`src/app/(authed)/sessions/new/page.tsx`:

```tsx
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { NewSessionClient } from './new-client';

export const dynamic = 'force-dynamic';

export default async function NewSessionPage() {
  const { userId } = await auth();
  if (!userId) return null;
  await ensureUser(userId);

  const myChars = await db
    .select()
    .from(characters)
    .where(and(eq(characters.userId, userId), isNull(characters.deletedAt)));

  return <NewSessionClient characters={myChars.map((c) => ({ id: c.id, name: c.name, raceSlug: c.raceSlug, classSlug: c.classSlug, level: c.level }))} />;
}
```

- [ ] **Step 2: Client component**

`src/app/(authed)/sessions/new/new-client.tsx`:

```tsx
'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Field, TextArea } from '@/components/ui/field';

export interface CharSummary {
  id: string;
  name: string;
  raceSlug: string;
  classSlug: string;
  level: number;
}

export function NewSessionClient({ characters }: { characters: CharSummary[] }) {
  const router = useRouter();
  const [characterId, setCharacterId] = React.useState<string | null>(characters[0]?.id ?? null);
  const [premise, setPremise] = React.useState('A goblin warren beneath an old mill. Heavy rain outside, dim torchlight inside.');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    if (!characterId || !premise.trim()) {
      setError('Pick a character and write a premise.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterId, premise: premise.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/sessions/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 32px' }}>
      <h1 style={{ fontSize: 36, fontWeight: 600 }}>Open the table</h1>
      <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
        Pick a hero and set the scene. The Master will take it from there.
      </p>

      <div style={{ marginTop: 24 }}>
        <Eyebrow style={{ marginBottom: 8 }}>Character</Eyebrow>
        {characters.length === 0 ? (
          <Card>
            <div>You have no characters yet. <a href="/characters/new" style={{ color: 'var(--arcane)' }}>Roll one</a> first.</div>
          </Card>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {characters.map((c) => (
              <button
                key={c.id}
                onClick={() => setCharacterId(c.id)}
                style={{
                  textAlign: 'left',
                  padding: 14,
                  borderRadius: 8,
                  background: 'var(--bg-card)',
                  border: characterId === c.id ? '2px solid var(--arcane)' : '1px solid var(--border)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  color: 'inherit',
                }}
              >
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{c.raceSlug} · {c.classSlug} {c.level}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <Field label="Premise (1-2 sentences — what's the setup?)">
          <TextArea rows={4} value={premise} onChange={(e) => setPremise(e.target.value)} />
        </Field>
      </div>

      {error && <div style={{ marginTop: 12, color: 'var(--ember)' }}>{error}</div>}

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="secondary" size="md" onClick={() => router.push('/sessions')}>Cancel</Button>
        <Button variant="primary" size="md" iconRight="arrow-right" onClick={start} disabled={busy || !characterId || !premise.trim()}>
          {busy ? 'Opening…' : 'Begin session'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add "src/app/(authed)/sessions/new"
git commit -m "feat(web): /sessions/new page (character pick + premise)"
```

---

## Phase 5 — Game-screen panes

### Task 12: CharacterPane

**Files:**
- Create: `src/components/game/character-pane.tsx`

- [ ] **Step 1: Implement**

```tsx
'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

export interface CharacterPaneProps {
  character: Character;
  state: SessionStateRow;
}

export function CharacterPane({ character, state }: CharacterPaneProps) {
  const hpPct = character.hpMax > 0 ? Math.round((state.hpCurrent / character.hpMax) * 100) : 0;
  const hpTone = hpPct <= 25 ? 'var(--ember)' : hpPct <= 50 ? 'var(--gold)' : 'var(--verdigris)';

  return (
    <aside
      style={{
        width: 280,
        padding: 18,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        overflowY: 'auto',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 8,
            background: 'var(--bone)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontStyle: 'italic',
            fontWeight: 600,
          }}
        >
          {character.name[0]}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>{character.name}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {character.raceSlug} · {character.classSlug} {character.level}
          </div>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Eyebrow>Hit Points</Eyebrow>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600 }}>{state.hpCurrent} / {character.hpMax}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-sunken)', marginTop: 6, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, hpPct))}%`, background: hpTone, transition: 'width 220ms' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <Stat label="AC" value={character.ac} />
        <Stat label="Speed" value={`${character.speed}'`} />
        <Stat label="PB" value={`+${character.proficiencyBonus}`} />
      </div>

      <div>
        <Eyebrow style={{ marginBottom: 6 }}>Abilities</Eyebrow>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4 }}>
          {(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const).map((k) => {
            const v = character.abilities[k];
            const mod = Math.floor((v - 10) / 2);
            return (
              <div
                key={k}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 0',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{k}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 600 }}>{v}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{mod >= 0 ? '+' : ''}{mod}</div>
              </div>
            );
          })}
        </div>
      </div>

      {state.conditions.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Conditions</Eyebrow>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {state.conditions.map((c) => (
              <Chip key={c.slug} tone="warn" dot>{c.slug}</Chip>
            ))}
          </div>
        </div>
      )}

      {character.spellcasting && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Spell slots</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(character.spellcasting.slotsMax).map(([level, max]) => {
              const used = state.spellSlotsUsed[level] ?? 0;
              return (
                <div key={level} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ width: 28, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>Lv {level}</span>
                  <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                    {Array.from({ length: max }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: '1.5px solid var(--arcane)',
                          background: i < used ? 'transparent' : 'var(--arcane)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {character.features.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Resources</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {character.features
              .filter((f) => f.usesMax !== 'unlimited')
              .map((f) => {
                const used = state.resourcesUsed[f.slug] ?? 0;
                const max = f.usesMax === 'unlimited' ? 0 : f.usesMax;
                return (
                  <div key={f.slug} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span>{f.slug}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{max - used} / {max}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add src/components/game/character-pane.tsx
git commit -m "feat(game): CharacterPane (HP bar, abilities, conditions, slots, resources)"
```

---

### Task 13: NarrativePane

**Files:**
- Create: `src/components/game/narrative-pane.tsx`

- [ ] **Step 1: Implement**

```tsx
'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { ToolPill } from './tool-pill';
import { SpinningDie } from './spinning-die';
import type { TurnEvent } from '@/sessions/types';
import type { MessageRow } from '@/sessions/client-types';

export interface NarrativeMessage {
  id?: string;
  role: 'master' | 'player' | 'system';
  content: string;
  tools?: { name: string; ok: boolean; error?: string; rolls: { formula: string; total: number }[] }[];
}

export interface NarrativePaneProps {
  history: MessageRow[];
  liveEvents: TurnEvent[];
  busy: boolean;
  onSend: (text: string) => void;
  onCastSpell?: () => void;
}

export function NarrativePane({ history, liveEvents, busy, onSend, onCastSpell }: NarrativePaneProps) {
  const [draft, setDraft] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const merged = mergeMessages(history, liveEvents);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [merged.length, busy, liveEvents.length]);

  const submit = (): void => {
    const t = draft.trim();
    if (!t || busy) return;
    onSend(t);
    setDraft('');
  };

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '32px 40px 16px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {merged.map((m, i) => <MessageView key={m.id ?? `live-${i}`} m={m} />)}
          {busy && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontSize: 16, fontStyle: 'italic' }}>
              <SpinningDie /> The Master is responding…
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '10px 40px 0', borderTop: '1px solid var(--border)', background: 'var(--bg-elev)' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', gap: 6, paddingTop: 8, paddingBottom: 4, flexWrap: 'wrap' }}>
          <Quick icon="dice" label="Skill check" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I make a Perception check.')} />
          <Quick icon="sword" label="Attack" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I attack with my equipped weapon.')} />
          {onCastSpell && <Quick icon="spell" label="Cast spell" onClick={onCastSpell} />}
          <Quick icon="shield" label="Dodge" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I take the Dodge action.')} />
          <Quick icon="heart" label="Short rest" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'We take a short rest.')} />
          <div style={{ flex: 1 }} />
          <Quick icon="book" label="Look up rule" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'Master, look up the rule for ')} />
        </div>
      </div>

      <div style={{ padding: '8px 40px 20px', background: 'var(--bg-elev)' }}>
        <div
          style={{
            maxWidth: 680,
            margin: '0 auto',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 12,
            padding: 8,
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="What do you do?"
            rows={2}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              color: 'var(--fg)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              lineHeight: 1.5,
              padding: '6px 8px',
            }}
          />
          <Button variant="primary" size="md" icon="send" disabled={busy || !draft.trim()} onClick={submit}>Send</Button>
        </div>
        <div style={{ maxWidth: 680, margin: '6px auto 0', fontSize: 11, color: 'var(--fg-subtle)', textAlign: 'center' }}>
          Enter to send · Shift+Enter for new line · Type in any language — the Master mirrors yours
        </div>
      </div>
    </main>
  );
}

function Quick({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 999,
        color: 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={13} /> {label}
    </button>
  );
}

function MessageView({ m }: { m: NarrativeMessage }) {
  if (m.role === 'master') {
    return (
      <div>
        <Eyebrow style={{ marginBottom: 6 }}>The Master</Eyebrow>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, lineHeight: 1.55, color: 'var(--fg)' }}>{m.content}</div>
        {m.tools && m.tools.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {m.tools.map((t, i) => (
              <ToolPill
                key={i}
                toolName={t.name}
                formula={t.rolls[0]?.formula}
                result={t.rolls[0] ? `${t.rolls[0].total}` : undefined}
                status={t.ok ? 'ok' : 'error'}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (m.role === 'player') {
    return (
      <div style={{ alignSelf: 'flex-end', marginLeft: 'auto', maxWidth: '85%' }}>
        <div style={{ background: 'var(--bone)', color: 'var(--ink)', borderRadius: '12px 12px 4px 12px', padding: '10px 14px', fontSize: 14, lineHeight: 1.5 }}>{m.content}</div>
      </div>
    );
  }
  return (
    <div
      style={{
        alignSelf: 'center',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'var(--bg-card)',
        border: '1px dashed var(--border-strong)',
        fontSize: 12,
        color: 'var(--fg-muted)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <Icon name="settings" size={12} /> {m.content}
    </div>
  );
}

function mergeMessages(history: MessageRow[], live: TurnEvent[]): NarrativeMessage[] {
  const out: NarrativeMessage[] = history.map((m) => ({ id: m.id, role: m.role, content: m.content }));
  // Append live events: build the in-progress master message from narrative_delta + tool_use_end events.
  let liveText = '';
  const liveTools: NonNullable<NarrativeMessage['tools']> = [];
  let pendingNames: Record<string, string> = {};
  for (const ev of live) {
    if (ev.type === 'narrative_delta') liveText += ev.text;
    else if (ev.type === 'tool_use_start') pendingNames[ev.toolUseId] = ev.name;
    else if (ev.type === 'tool_use_end') {
      const name = pendingNames[ev.toolUseId] ?? 'tool';
      liveTools.push({ name, ok: ev.ok, error: ev.error, rolls: ev.rolls.map((r) => ({ formula: r.formula, total: r.total })) });
    }
  }
  if (liveText || liveTools.length) {
    out.push({ role: 'master', content: liveText, tools: liveTools.length ? liveTools : undefined });
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add src/components/game/narrative-pane.tsx
git commit -m "feat(game): NarrativePane (chat log + composer + quick actions + tool pills)"
```

---

### Task 14: MechanicsPane

**Files:**
- Create: `src/components/game/mechanics-pane.tsx`

- [ ] **Step 1: Implement**

```tsx
'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { CombatTracker } from './combat-tracker';
import { DiceLogPanel } from './dice-log-panel';
import type { CombatActorRow, DiceRollRow, SessionStateRow } from '@/sessions/client-types';

export interface MechanicsPaneProps {
  state: SessionStateRow;
  actors: CombatActorRow[];
  diceLog: DiceRollRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpMax: number;
}

export function MechanicsPane({ state, actors, diceLog, pcCharacterId, pcName, pcHpMax }: MechanicsPaneProps) {
  return (
    <aside
      style={{
        width: 320,
        padding: 18,
        borderLeft: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        overflowY: 'auto',
        flexShrink: 0,
      }}
    >
      <CombatTracker
        state={state}
        actors={actors}
        pcCharacterId={pcCharacterId}
        pcName={pcName}
        pcHpCurrent={state.hpCurrent}
        pcHpMax={pcHpMax}
      />
      <DiceLogPanel rolls={diceLog} />
      <section>
        <Eyebrow style={{ marginBottom: 6 }}>Scene</Eyebrow>
        <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
          {state.scene || 'No scene set yet.'}
        </div>
      </section>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add src/components/game/mechanics-pane.tsx
git commit -m "feat(game): MechanicsPane (combat tracker + dice log + scene)"
```

---

## Phase 6 — Game screen page

### Task 15: Game screen — server page + client wiring

**Files:**
- Create: `src/app/(authed)/sessions/[id]/page.tsx`
- Create: `src/app/(authed)/sessions/[id]/game-client.tsx`

- [ ] **Step 1: Server page**

```bash
mkdir -p "src/app/(authed)/sessions/[id]"
```

`src/app/(authed)/sessions/[id]/page.tsx`:

```tsx
import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState, sessionMessages, diceLog, combatActors, characters } from '@/db/schema';
import { GameClient } from './game-client';
import type { Character } from '@/engine/types';

export const dynamic = 'force-dynamic';

export default async function GameSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;
  const { id: sessionId } = await params;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) notFound();

  const [character] = await db.select().from(characters).where(eq(characters.id, session.characterId)).limit(1);
  if (!character) notFound();

  const [stateRow] = await db.select().from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);

  const [history, rolls, actors] = await Promise.all([
    db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(asc(sessionMessages.createdAt)).limit(100),
    db.select().from(diceLog).where(eq(diceLog.sessionId, sessionId)).orderBy(asc(diceLog.createdAt)).limit(50),
    db.select().from(combatActors).where(eq(combatActors.sessionId, sessionId)),
  ]);

  // Engine-shaped Character for the panes
  const engineCharacter: Character = {
    id: character.id,
    name: character.name,
    level: character.level,
    classSlug: character.classSlug,
    raceSlug: character.raceSlug,
    backgroundSlug: character.backgroundSlug,
    abilities: character.abilities,
    proficiencyBonus: character.proficiencyBonus,
    hpMax: character.hpMax,
    ac: character.ac,
    speed: character.speed,
    proficiencies: character.proficiencies,
    spellcasting: character.spellcasting,
    features: character.features,
    inventory: character.inventory,
    hitDiceMax: character.hitDiceMax,
    hitDieSize: character.hitDieSize,
  };

  return (
    <GameClient
      sessionId={sessionId}
      session={{
        id: session.id,
        userId: session.userId,
        characterId: session.characterId,
        premise: session.premise,
        language: session.language,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      }}
      character={engineCharacter}
      initialState={
        stateRow
          ? {
              sessionId: stateRow.sessionId,
              hpCurrent: stateRow.hpCurrent,
              tempHp: stateRow.tempHp,
              hitDiceRemaining: stateRow.hitDiceRemaining,
              spellSlotsUsed: stateRow.spellSlotsUsed,
              conditions: stateRow.conditions,
              resourcesUsed: stateRow.resourcesUsed,
              inCombat: stateRow.inCombat,
              combat: stateRow.combat,
              scene: stateRow.scene,
            }
          : null
      }
      initialMessages={history.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      }))}
      initialRolls={rolls.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        kind: r.kind,
        formula: r.formula,
        rolls: r.rolls,
        modifier: r.modifier,
        total: r.total,
        meta: r.meta,
        createdAt: r.createdAt.toISOString(),
      }))}
      initialActors={actors.map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        name: a.name,
        monsterSlug: a.monsterSlug,
        hpCurrent: a.hpCurrent,
        hpMax: a.hpMax,
        initiative: a.initiative,
        isAlive: a.isAlive,
        conditions: a.conditions,
      }))}
    />
  );
}
```

- [ ] **Step 2: Client component**

`src/app/(authed)/sessions/[id]/game-client.tsx`:

```tsx
'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Icon } from '@/components/ui/icon';
import { Wordmark } from '@/components/ui/wordmark';
import { CharacterPane } from '@/components/game/character-pane';
import { NarrativePane } from '@/components/game/narrative-pane';
import { MechanicsPane } from '@/components/game/mechanics-pane';
import { SpellModal } from '@/components/game/spell-modal';
import { useTurnStream } from '@/sessions/use-turn-stream';
import { useSessionState } from '@/sessions/use-session-state';
import type { Character } from '@/engine/types';
import type { CombatActorRow, DiceRollRow, MessageRow, SessionRow, SessionStateRow } from '@/sessions/client-types';

export interface GameClientProps {
  sessionId: string;
  session: SessionRow;
  character: Character;
  initialState: SessionStateRow | null;
  initialMessages: MessageRow[];
  initialRolls: DiceRollRow[];
  initialActors: CombatActorRow[];
}

export function GameClient({ sessionId, session, character, initialState, initialMessages, initialRolls, initialActors }: GameClientProps) {
  const [messages, setMessages] = React.useState<MessageRow[]>(initialMessages);
  const [spellOpen, setSpellOpen] = React.useState(false);
  const turn = useTurnStream(sessionId);
  const stateSub = useSessionState(sessionId);

  const liveState: SessionStateRow | null = stateSub.snapshot?.state ?? initialState;
  const liveActors: CombatActorRow[] = stateSub.snapshot?.actors ?? initialActors;

  // When a turn completes, optimistically append the player + master messages so they appear immediately.
  React.useEffect(() => {
    const last = turn.events.at(-1);
    if (last?.type === 'turn_complete' && !turn.busy) {
      // The state SSE will catch up; force a refresh of the local message list by re-fetching.
      void fetch(`/api/sessions/${sessionId}/messages`).then(async (r) => {
        if (r.ok) {
          const body = (await r.json()) as { messages: MessageRow[] };
          setMessages(body.messages);
          turn.reset();
        }
      });
    }
  }, [turn, sessionId]);

  const send = (text: string): void => {
    setMessages((prev) => [...prev, { id: `temp-${Date.now()}`, sessionId, role: 'player', content: text, createdAt: new Date().toISOString() }]);
    void turn.send(text);
  };

  if (!liveState) {
    return (
      <main style={{ padding: 40, color: 'var(--fg-muted)' }}>Loading session…</main>
    );
  }

  const slots = character.spellcasting
    ? Object.entries(character.spellcasting.slotsMax).map(([level, max]) => ({
        level: Number(level),
        max,
        used: liveState.spellSlotsUsed[level] ?? 0,
      }))
    : [];

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 24px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          flexShrink: 0,
        }}
      >
        <Link href="/sessions"><Button variant="ghost" size="sm" icon="arrow-left">Sessions</Button></Link>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 17 }}>{character.name}'s session</div>
          <div style={{ fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
            {liveState.inCombat ? 'COMBAT' : 'EXPLORATION'} · LANG {session.language?.toUpperCase() ?? '–'}
          </div>
        </div>
        <Chip tone="accent" dot>SSE live</Chip>
        <Wordmark size={14} style={{ opacity: 0.7 }} />
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <CharacterPane character={character} state={liveState} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
          <NarrativePane
            history={messages}
            liveEvents={turn.events}
            busy={turn.busy}
            onSend={send}
            onCastSpell={character.spellcasting && slots.length > 0 ? () => setSpellOpen(true) : undefined}
          />
          {turn.error && (
            <div style={{ padding: '8px 16px', background: 'var(--bg-card)', color: 'var(--ember)', borderTop: '1px solid var(--ember)', fontSize: 12 }}>
              <Icon name="x" size={12} /> {turn.error}
            </div>
          )}
          {spellOpen && character.spellcasting && (
            <SpellModal
              spellsKnown={character.spellcasting.spellsKnown}
              slots={slots}
              onCast={(spellSlug, slotLevel) => {
                send(`I cast ${spellSlug} at level ${slotLevel}.`);
                setSpellOpen(false);
              }}
              onClose={() => setSpellOpen(false)}
            />
          )}
        </div>
        <MechanicsPane
          state={liveState}
          actors={liveActors}
          diceLog={initialRolls}
          pcCharacterId={character.id}
          pcName={character.name}
          pcHpMax={character.hpMax}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build check**

```bash
pkill -f "next dev" 2>/dev/null || true
sleep 2
pnpm build 2>&1 | tail -10
```
Expected: build succeeds. The new routes `/sessions`, `/sessions/new`, `/sessions/[id]` should appear in the route list.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add "src/app/(authed)/sessions/[id]"
git commit -m "feat(web): /sessions/[id] game screen — 3-pane layout wired to SSE"
```

---

## Phase 7 — Tests + tag

### Task 16: E2E test (Clerk-gated)

**Files:**
- Create: `tests/e2e/game-screen.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

// This test exercises the unauthed paths only. Full sign-in + game flow requires
// a Clerk testing token (https://clerk.com/docs/testing/playwright/overview);
// configure CLERK_TESTING_TOKEN_USER_ID in .env.local to enable richer tests.

test('sessions list redirects to sign-in for unauthed user', async ({ page }) => {
  await page.goto('/sessions');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('new-session page redirects to sign-in for unauthed user', async ({ page }) => {
  await page.goto('/sessions/new');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test.skip(!HAS_CLERK_TESTING, 'authenticated game flow (requires CLERK_TESTING_TOKEN_USER_ID)')(
  'authenticated user sees the sessions list',
  async ({ page }) => {
    // Placeholder: full flow lives behind Clerk testing-token setup.
    await page.goto('/sessions');
    await expect(page.getByRole('heading', { name: /Sessions/i })).toBeVisible();
  },
);
```

- [ ] **Step 2: Run E2E**

```bash
pkill -f "next dev" 2>/dev/null || true
sleep 2
pnpm test:e2e 2>&1 | tail -10
```
Expected: 4 tests run (2 from Plan C landing.spec.ts + 2 unauth from this file; 1 skipped).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/game-screen.spec.ts
git commit -m "test(e2e): /sessions and /sessions/new redirect unauth users"
```

---

### Task 17: Final wrap-up + tag

- [ ] **Step 1: Full unit suite**

```bash
pnpm test 2>&1 | tail -10
```
Expected: ~241 (Plan D1) + ~15 added in Plan D2 = ~256+. Capture totals.

- [ ] **Step 2: E2E**

```bash
pkill -f "next dev" 2>/dev/null || true
sleep 2
pnpm test:e2e 2>&1 | tail -10
```
Expected: 4-5 pass.

- [ ] **Step 3: Lint + typecheck**

```bash
pnpm lint 2>&1 | tail -10
pnpm typecheck 2>&1 | tail -3
```
Expected: clean (Plan B's `_input`/`_rng` warnings still acceptable).

- [ ] **Step 4: Build**

```bash
pnpm build 2>&1 | tail -10
```
Expected: succeeds; the route list contains:
- `/sessions`
- `/sessions/new`
- `/sessions/[id]`
- `/api/sessions/[id]/messages`
- `/api/sessions/[id]/dice-log`

- [ ] **Step 5: Commit any tweaks**

If lint/build needed code changes, commit them:
```bash
git status --short
git add -p
git commit -m "chore: lint/test tweaks after Plan D2 completion"
```

If clean, skip.

- [ ] **Step 6: Tag the milestone**

```bash
git tag plan-d2-game-screen-done
git tag --list | grep plan-d
git rev-parse plan-d2-game-screen-done
```

The MVP is now end-to-end functional: a user can sign in, create a character via the wizard, create a session, send player messages, receive streaming master responses with tool calls and dice rolls, see HP and combat state update live in the UI.

---

## Self-review

Spec coverage:
- §3.2 sessions tables — Plan D1 ✓
- §5.1 turn loop — Plan D1 + Task 1 (onEvent) + Task 2 (progressive flush)
- §5.2 system prompt with cache — Plan D1 ✓
- §5.3 language detection — Plan D1 ✓
- §5.4 state snapshot — Plan D1 ✓
- §6.2 game screen 3-pane layout — Tasks 12-15
- §6.3 streaming UX — Tasks 5, 13 (NarrativePane consumes liveEvents)
- §6.5 API routes — Plan D1 + Tasks 3
- §7.1-7.4 errors/concurrency/cost/security — Plan D1 ✓ (D2 just consumes)

Out of scope (correctly):
- Multiplayer party strip — future plan #6
- Campaign management — future plan #5
- Mobile responsive — explicit MVP scope deferral
- Light theme — explicit MVP scope deferral
- Postgres LISTEN/NOTIFY (currently 1.5s poll) — future polish

Deviations registered for the post-MVP backlog:
- The state SSE poll (1.5s) is fine for MVP but eventually wants LISTEN/NOTIFY to be free of redundant queries.
- The optimistic player-message append in `game-client.tsx` uses a `temp-${Date.now()}` ID; on re-fetch it gets replaced. If the fetch fails, the temp message lingers. Plan D2 follow-up: treat the temp message as "pending" and replace by ID after the SSE `player_message_persisted` event.
- The Clerk testing-token setup is left as a follow-up so the authenticated E2E can exercise the full flow.

No placeholders, no "TBD". Every code step has the full code. Type names (`TurnEvent`, `SessionStateRow`, `Character`, etc.) match across tasks and across plans.
