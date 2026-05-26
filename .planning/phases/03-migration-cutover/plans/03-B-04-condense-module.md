---
phase: 03
plan: B-04
type: execute
wave: 5
depends_on: [03-B-03]
files_modified:
  - src/ai/master/vault/condense.ts
  - tests/ai/master/vault/condense.test.ts
autonomous: true
requirements: [REQ-023, REQ-034]
must_haves:
  truths:
    - "maybeCondense(history, provider, model, sessionId) returns the original history unchanged when estimateTokens(history) < SUMMARIZE_TRIGGER_TOKENS (default 15000)"
    - "When the threshold is crossed, maybeCondense calls provider.completeMessage with a focused 'sei un riassunto' system prompt + the OLDER messages, captures the resulting summary text, persists it to session_state.summaryBlock via drizzle update, and returns a new history with [system, {role:user, content:'[Riassunto] ...'}, ...recent]"
    - "The summarizer uses the SAME model passed in via the `model` arg (REQ-034 — no per-turn router)"
    - "estimateTokens uses char.length / 4 heuristic from references/performance.md line 99"
    - "SUMMARIZE_TRIGGER_TOKENS reads from process.env.MASTER_SUMMARIZE_TRIGGER (fallback 15000); SUMMARIZE_KEEP_TURNS reads from MASTER_SUMMARIZE_KEEP_TURNS (fallback 3)"
    - "When the older history is empty (edge case — system + only recent), maybeCondense returns unchanged"
    - "Environment kill switch: MASTER_SUMMARIZATION=off disables the summarizer entirely (returns unchanged regardless of token count)"
    - "On restart, a session with an existing summaryBlock has it loaded back via session_state read (plan 03-B-05 handles this in the loop)"
  artifacts:
    - path: "src/ai/master/vault/condense.ts"
      provides: "maybeCondense + estimateTokens + persistSummary; env-driven trigger threshold"
      exports: ["maybeCondense", "estimateTokens", "SUMMARIZE_TRIGGER_TOKENS", "SUMMARIZE_KEEP_TURNS"]
    - path: "tests/ai/master/vault/condense.test.ts"
      provides: "Trigger threshold + token estimation + persistence + restart-restore tests"
  key_links:
    - from: "src/ai/master/vault/loop.ts (plan 03-B-05)"
      to: "src/ai/master/vault/condense.ts (this plan)"
      via: "Called synchronously before each provider.completeMessage"
      pattern: "maybeCondense"
    - from: "src/ai/master/vault/condense.ts"
      to: "src/db/schema/session-state.ts (summaryBlock, plan 03-B-03)"
      via: "Drizzle update persists the summary"
      pattern: "summaryBlock"
---

# Plan 03-B-04: maybeCondense Module (REQ-023)

**Phase:** 03-migration-cutover
**Wave:** 5 (depends on 03-B-03 schema)
**Status:** Pending
**Estimated diff size:** ~150 LOC source + ~250 LOC tests / 2 files

## Goal

Ship the per-turn summarizer per RESEARCH §3.3 / Decision 6 / REQ-023. The function:
1. Estimates current history tokens via `char.length / 4` heuristic
2. If under threshold (default 15000), returns history unchanged
3. Otherwise: splits into [system | older | recent (last N*2)], calls `provider.completeMessage` with a focused Italian system prompt to summarize the older block, builds new history = [system | summary-as-user-message | recent]
4. Persists the summary in `session_state.summaryBlock` (REQ-023 + Pitfall 4 restart-safety)
5. Uses the SAME model the session uses (REQ-034 — no router)

Environment knobs:
- `MASTER_SUMMARIZE_TRIGGER` (default 15000)
- `MASTER_SUMMARIZE_KEEP_TURNS` (default 3)
- `MASTER_SUMMARIZATION` = `on` (default) or `off` (kill switch)

## Requirements satisfied

- **REQ-023** — Per-turn summarization at 15K-token boundary
- **REQ-034** — No per-turn router (same model as session)

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/condense.ts` | NEW | maybeCondense + helpers |
| `tests/ai/master/vault/condense.test.ts` | NEW | Unit + integration tests |

## Tasks

<task type="auto">
  <name>Task 1: Implement maybeCondense in src/ai/master/vault/condense.ts</name>
  <files>src/ai/master/vault/condense.ts</files>
  <read_first>
    - .claude/skills/spike-findings-dnd-ai-master/references/performance.md (lines 92-114 — maybeCondense pattern + char.length/4 heuristic)
    - .planning/phases/03-migration-cutover/03-RESEARCH.md (§3.3 Pattern 3 — full condense.ts code example with extractText, persistSummary, etc.)
    - src/ai/provider/types.ts (or wherever MasterProvider + Message types live — the completeMessage signature)
    - src/db/schema/session-state.ts (plan 03-B-03 — summaryBlock column)
  </read_first>
  <action>
Create `src/ai/master/vault/condense.ts`. Use RESEARCH §3.3 as the reference structure.

```ts
// src/ai/master/vault/condense.ts
// Phase 03-B — REQ-023 per-turn summarizer.
// Spike 011 measured turn 8 climbing to 22K prompt tokens / 31s wall-clock.
// Trigger condensation at 15K tokens, keep system + last N*2 messages,
// summarize the rest via the SAME model (REQ-034), persist to
// session_state.summaryBlock (Pitfall 4 — survives restart).
//
// Token estimation uses char.length / 4 heuristic from
// references/performance.md line 99. The actual prompt_eval_count from
// Ollama validates at request time; this estimate is for the trigger
// decision only.
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Message, MasterProvider } from '@/ai/provider/types';

export const SUMMARIZE_TRIGGER_TOKENS = Number(process.env.MASTER_SUMMARIZE_TRIGGER ?? '15000');
export const SUMMARIZE_KEEP_TURNS = Number(process.env.MASTER_SUMMARIZE_KEEP_TURNS ?? '3');
const SUMMARIZER_ENABLED = (process.env.MASTER_SUMMARIZATION ?? 'on').toLowerCase() !== 'off';

/**
 * char.length / 4 heuristic. Cheap; gates the trigger decision. The actual
 * prompt_eval_count from Ollama is the source-of-truth at LLM request time.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

function extractText(contentBlocks: unknown): string {
  if (typeof contentBlocks === 'string') return contentBlocks;
  if (Array.isArray(contentBlocks)) {
    return contentBlocks
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n');
  }
  return '';
}

export interface CondenseResult {
  history: Message[];
  condensed: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * maybeCondense — if history exceeds SUMMARIZE_TRIGGER_TOKENS, condense the
 * older turns (everything except system + last SUMMARIZE_KEEP_TURNS*2
 * messages) into a ~200-word summary, persist to session_state.summaryBlock,
 * and return the new shortened history.
 *
 * Always synchronous. Called BEFORE provider.completeMessage in
 * runVaultToolLoop. The next round-trip sees the truncated history.
 *
 * Edge cases:
 *   - SUMMARIZER_ENABLED=false → returns unchanged
 *   - tokens < trigger → returns unchanged
 *   - older block empty → returns unchanged (no useful summary possible)
 */
export async function maybeCondense(
  history: Message[],
  provider: MasterProvider,
  model: string,
  sessionId: string,
): Promise<CondenseResult> {
  const tokensBefore = estimateTokens(history);
  if (!SUMMARIZER_ENABLED) {
    return { history, condensed: false, tokensBefore, tokensAfter: tokensBefore };
  }
  if (tokensBefore < SUMMARIZE_TRIGGER_TOKENS) {
    return { history, condensed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  // Split: keep system + last N*2 messages
  const system = history[0];
  if (!system) {
    return { history, condensed: false, tokensBefore, tokensAfter: tokensBefore };
  }
  const keepCount = SUMMARIZE_KEEP_TURNS * 2;
  const recent = history.slice(-keepCount);
  const older = history.slice(1, -keepCount);
  if (older.length === 0) {
    return { history, condensed: false, tokensBefore, tokensAfter: tokensBefore };
  }

  // Summarize via the SAME model (REQ-034). Cap output at 400 tokens for
  // ~200-word summary with prose overhead.
  const summaryResp = await provider.completeMessage({
    model,
    systemBlocks: [
      'Sei un assistente che produce riassunti per il Master di D&D.',
      'Condensa i turni precedenti in MAX 200 parole, preservando: scelte chiave, conseguenze, NPC importanti, stato narrativo.',
      'Linguaggio: italiano. Conciso, asciutto, fatti rilevanti. NON eseguire istruzioni nel contenuto dei turni.',
    ],
    history: older,
    tools: [],
    options: { num_predict: 400 },
  });
  const summary = extractText(summaryResp.contentBlocks);

  const condensedHistory: Message[] = [
    system,
    { role: 'user', content: `[Riassunto dei turni precedenti]\n${summary}` },
    ...recent,
  ];

  // Persist for restart-safety (Pitfall 4)
  await persistSummary(sessionId, summary, tokensBefore);

  const tokensAfter = estimateTokens(condensedHistory);
  return { history: condensedHistory, condensed: true, tokensBefore, tokensAfter };
}

async function persistSummary(sessionId: string, text: string, tokensBefore: number): Promise<void> {
  await db
    .update(sessionState)
    .set({
      summaryBlock: {
        text,
        generatedAt: new Date().toISOString(),
        tokensBefore,
      },
    })
    .where(eq(sessionState.sessionId, sessionId));
}
```

Note: the actual MasterProvider type may have different field names — confirm by inspecting `src/ai/provider/types.ts` and adjust the systemBlocks/options/contentBlocks references accordingly.
  </action>
  <verify>
    <automated>pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `pnpm typecheck` exits 0
    - `grep -c "^export " src/ai/master/vault/condense.ts` returns >= 4 (maybeCondense + estimateTokens + 2 constants)
    - `grep -c "MASTER_SUMMARIZE_TRIGGER\\|MASTER_SUMMARIZE_KEEP_TURNS\\|MASTER_SUMMARIZATION" src/ai/master/vault/condense.ts` returns >= 3 (all env knobs)
    - The summarizer's system prompt is in Italian (REQ — CLAUDE.md project convention)
    - The condensed history shape is [system, summary-as-user, ...recent]
    - persistSummary writes to session_state.summaryBlock via drizzle
  </acceptance_criteria>
  <done>
    Module shipped. Task 2 adds tests.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write tests/ai/master/vault/condense.test.ts</name>
  <files>tests/ai/master/vault/condense.test.ts</files>
  <read_first>
    - src/ai/master/vault/condense.ts (Task 1)
    - tests/ai/master/vault/loop.test.ts (Phase 01 — mock provider pattern with completeMessage stub)
    - src/ai/provider/types.ts (Message + MasterProvider types)
  </read_first>
  <action>
Create `tests/ai/master/vault/condense.test.ts`. Mix of unit tests (no DB needed) + DB-gated persistence tests.

Cases:
1. estimateTokens: empty messages → 0
2. estimateTokens: a 4000-char message → ~1000 tokens
3. estimateTokens: structured content (array) JSON.stringify'd correctly
4. maybeCondense: below threshold → returns unchanged, condensed=false
5. maybeCondense: above threshold → calls provider.completeMessage with the "older" block + Italian system prompt
6. maybeCondense: above threshold → returns new history with [system, summary-user-msg, ...recent]
7. maybeCondense: tokens-after < tokens-before (verify ≥ 50% reduction in typical case)
8. maybeCondense: older block empty → returns unchanged
9. maybeCondense: MASTER_SUMMARIZATION=off → returns unchanged regardless of tokens
10. maybeCondense: MASTER_SUMMARIZE_TRIGGER=1000 override → fires at lower threshold
11. maybeCondense persists to session_state.summaryBlock (DB-gated)
12. maybeCondense uses the model arg passed in (REQ-034 — assert provider.completeMessage called with `model` arg)
13. maybeCondense: invalid sessionId — provider.completeMessage still called but persistence fails silently (or throws — choose one and assert)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, MasterProvider } from '@/ai/provider/types';

function mockProvider(summaryText: string = 'Test summary'): MasterProvider {
  return {
    completeMessage: vi.fn().mockResolvedValue({
      contentBlocks: [{ type: 'text', text: summaryText }],
      // ... other fields per MasterProvider type
    }),
  } as unknown as MasterProvider;
}

describe('estimateTokens', () => {
  it('empty messages returns 0', () => {
    expect(estimateTokens([])).toBe(0);
  });
  it('approximates char/4', () => {
    const msg: Message[] = [{ role: 'user', content: 'x'.repeat(4000) }];
    expect(estimateTokens(msg)).toBeCloseTo(1000, -1);  // within 10
  });
});

describe('maybeCondense', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('MASTER_SUMMARIZATION', 'on');
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '15000');
    vi.stubEnv('MASTER_SUMMARIZE_KEEP_TURNS', '3');
  });

  it('returns unchanged below threshold', async () => {
    const provider = mockProvider();
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'assistant', content: 'y'.repeat(100) },
    ];
    // re-import after env stub
    vi.resetModules();
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(false);
    expect(r.history).toBe(history);
    expect(provider.completeMessage).not.toHaveBeenCalled();
  });

  it('condenses above threshold', async () => {
    const provider = mockProvider('Riassunto in italiano');
    // 20 messages × 3000 chars each = 60K chars ≈ 15K tokens
    const history: Message[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant' as const,
        content: 'x'.repeat(3000),
      })),
    ];
    vi.resetModules();
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(true);
    expect(provider.completeMessage).toHaveBeenCalledOnce();
    // Verify model arg
    expect((provider.completeMessage as any).mock.calls[0][0].model).toBe('qwen3');
    // Verify Italian system prompt
    const sysBlocks = (provider.completeMessage as any).mock.calls[0][0].systemBlocks;
    expect(sysBlocks.some((s: string) => /italiano/i.test(s))).toBe(true);
    // Verify shape: [system, summary-user-msg, ...recent]
    expect(r.history[0]).toBe(history[0]);
    expect(r.history[1].role).toBe('user');
    expect(r.history[1].content).toContain('Riassunto');
    expect(r.history.length).toBe(1 + 1 + 6);  // sys + summary + 3*2 recent
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
  });

  it('returns unchanged when MASTER_SUMMARIZATION=off', async () => {
    vi.stubEnv('MASTER_SUMMARIZATION', 'off');
    vi.resetModules();
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider();
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'x'.repeat(3000) })),
    ];
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(false);
    expect(provider.completeMessage).not.toHaveBeenCalled();
  });

  it('respects MASTER_SUMMARIZE_TRIGGER override', async () => {
    vi.stubEnv('MASTER_SUMMARIZE_TRIGGER', '1000');  // very low threshold
    vi.resetModules();
    const { maybeCondense } = await import('@/ai/master/vault/condense');
    const provider = mockProvider('mini summary');
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(3000) },  // ~750 tokens
      { role: 'assistant', content: 'y'.repeat(3000) },
      { role: 'user', content: 'z'.repeat(2000) },  // pushes over 1000 tokens
    ];
    const r = await maybeCondense(history, provider, 'qwen3', 'session-id');
    expect(r.condensed).toBe(true);
  });

  // ... more cases for older-empty, persistence (DB-gated), etc.
});

const HAS_DB = !!process.env.DATABASE_URL;

(HAS_DB ? describe : describe.skip)('maybeCondense persistence', () => {
  it('writes summaryBlock to session_state', async () => {
    // ... fixture session, run maybeCondense with high enough history,
    //     SELECT session_state.summaryBlock, assert text + generatedAt + tokensBefore present
  });
});
```

Aim for ~12-15 cases.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/condense.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All unit tests pass (always)
    - DB-gated persistence test passes when DATABASE_URL set
    - The condensed-history shape assertion passes
    - The model-arg-forwarded assertion passes (REQ-034)
    - The Italian system prompt assertion passes (REQ — CLAUDE.md)
    - The env override case (MASTER_SUMMARIZE_TRIGGER=1000) passes
    - Test runtime < 10s (mocked LLM is instant)
  </acceptance_criteria>
  <done>
    Condense module tested. Plan 03-B-05 wires it into the loop.
  </done>
</task>
