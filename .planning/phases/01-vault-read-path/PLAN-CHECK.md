# Plan Check: Phase 01 Vault Read Path

**Date:** 2026-05-24
**Verdict:** **PASS (post-revision)** — initial review flagged 1 blocker + 4 polish warnings; all 5 applied below. Ready for execution.

## Revisions applied (2026-05-24, same-session iteration)

| # | Severity | Plan | Change |
|---|---|---|---|
| 1 | BLOCKER | 06 | Replaced `masterBackend?: never` with parallel-shape pattern: added `masterBackend?: MasterBackend` to `UserPreferences` (task 1a) + updated `DEFAULT_PREFERENCES` (task 1b). Documented rationale in Tasks section. |
| 2 | dependent | 07 | Dropped the `(userPrefs as { masterBackend?: MasterBackend })` cast on line 59. After revision #1, `userPrefs.masterBackend` is directly typed. |
| 3 | cosmetic | 05 | Fixed package.json placement instruction — removed inaccurate "alphabetically between migrate-legacy-template-sessions and lint" guidance; now reads "near the other top-level migration scripts; implementer's call." |
| 4 | cosmetic | 07 | `finalizeTurn` signature: trimmed `campaign` and `snap` to optional (`?:`) with inline comment "Reserved for Phase 02 (`apply_event` payload construction may need these)". |
| 5 | warning | 08 | Added concrete Clerk JWT extraction recipe (devtools → Application → Cookies → `__session`) + 7-day expiry note + rationale for NOT using `--bypass-http` in Phase 01. |
| 6 | warning | 09 | Added two follow-ups to SUMMARY.md template: (a) vitest scans only `tests/**/` (RESEARCH.md was wrong about colocated tests), (b) `--bypass-http` is a Phase 02 polish. |

The original review findings are preserved below for traceability. The final verdict is **PASS**.

---

## REQ coverage matrix

| REQ | Plan(s) | Verified |
|---|---|---|
| REQ-001 (filesystem-only markdown) | 05 | ✓ covered |
| REQ-002 (path-deterministic `/handbook/<category>/<id>.md`) | 01 (root constant), 05 (taxonomy) | ✓ covered |
| REQ-010 (4-tool surface — 3 of 4 in Phase 01) | 03, 04 | ✓ covered (`apply_event` is Phase 02 by design) |
| REQ-011 (no singular `read_vault`) | 03 (grep gate), 09 (smoke test) | ✓ covered |
| REQ-012 (lenient discovery `/tools/index.md`) | 02 (prompt), 05 (file gen) | ✓ covered |
| REQ-013 (both terminators) | 03 (`end_turn` def), 04 (loop) | ✓ covered |
| REQ-014 (`safeVaultPath()`) | 01 | ✓ covered |
| REQ-021 (warm < 10s on M4) | 08 (bench), 02+04+07 (vehicle) | ✓ covered (manual measurement) |
| REQ-022 (pure-function builder + lint) | 02 | ✓ covered |
| REQ-030 (qwen3 base slug) | 07 (passthrough) | ✓ covered |
| REQ-033 (drop baked variants for vault campaigns) | 07 (no SRD/handbook/RAG calls) | ✓ covered |

**All 11 REQs covered.** No silent drops.

## Plan-by-plan verdict

| Plan | Goal-backward | Atomic | Concrete verification | Tests | Notes |
|---|---|---|---|---|---|
| 01-vault-path-safety | ✓ | ✓ (~200 LOC) | ✓ commands + file checks + grep gates | ✓ (8+ cases) | Foundation clean |
| 02-vault-prompt-builder | ✓ | ✓ (~180 LOC) | ✓ 1000-build SHA + grep + snapshot | ✓ (8+ cases) | Spike-012 pattern correctly applied |
| 03-vault-tool-definitions | ✓ | ✓ (~240 LOC) | ✓ typecheck + grep gates + JSON inspection | ✓ (11 cases) | Tool schema verified against `Anthropic.Messages.Tool` |
| 04-vault-tool-loop | ✓ | ⚠ (400 LOC total) | ✓ 9 scripted scenarios | ✓ (9 cases) | Within tolerance; parallel-loop is research-validated |
| 05-migration-script | ✓ | ✓ (~370 LOC) | ✓ file counts + SHA + idempotency | ✓ (7 cases) | H2 counts CORRECT (12 + 8 = 20); research was wrong |
| 06-campaign-settings-flag | ✓ | ✓ (~130 LOC) | ✓ typecheck + curl smoke + grep | ✓ (9 cases) | **BLOCKER: `masterBackend?: never` workaround won't compile** |
| 07-turn-route-branch | ✓ | ⚠ (200 LOC + 80 LOC test) | ✓ typecheck + spy mocks + manual smoke | ✓ (9 cases) | Helper extractions verified as pure lift-and-relocate |
| 08-m4-bench-runner | ✓ | ✓ (~200 LOC) | ✓ pre-flight + summary table | ✗ (intentional — bench, not testable in isolation) | **WARNING: `--user-jwt` ergonomics on M4** |
| 09-rollout-and-docs | ✓ | ✓ (~150 LOC) | ✓ barrel smoke + file checks | ✓ (4 cases) | Wrap-up, REQ traceability complete |

## Investigation of planner's 7 concerns

### Concern 1: Plan 07 helper extraction risk — **PASS**

- `buildBudgetedHistory` source range: `route.ts:280-380` (~100 LOC). All dependencies captured in plan 07's signature.
- `finalizeTurn` source range: `route.ts:599-677` (~78 lines). Dependencies match plan 07's signature.
- Extraction is byte-for-byte lift-and-relocate. No logic transformation required.
- `finally` block (lines 692-695): runs `touchCampaign` + `releaseTurnLock` regardless of early `return` from `try`. Plan 07's vault-branch `return;` lands inside the `try` — the `finally` still fires, turn-lock release preserved.

**Minor nit:** plan 07's `finalizeTurn` signature includes `campaign` and `snap` in args, but the post-loop block does NOT reference either. Cosmetic, not blocking.

### Concern 2: Plan 06/07 type bleed (`UserPreferences` vs `CampaignSettings`) — **NEEDS_REVISION**

Verified in `src/db/schema/users.ts` and `src/db/schema/campaigns.ts`:

- `UserPreferences` and `CampaignSettings` are SEPARATE interfaces. They overlap structurally on many fields but neither extends the other.
- `getSessionMasterPreferences` (`preferences.ts:257-268`) returns `Required<UserPreferences>` via `return { ...camp, ttsAutoplay: false }` where `camp` is `Required<CampaignSettings>`. TypeScript currently accepts this only because CampaignSettings ⊂ UserPreferences (every field on CampaignSettings is also on UserPreferences).

**The bug in Plan 06 task 2:**

After adding `masterBackend?: MasterBackend` to CampaignSettings, `Required<CampaignSettings>` includes `masterBackend: MasterBackend`. The spread becomes:

```ts
return { ...camp /* has masterBackend */, ttsAutoplay: false };  // typed as Promise<Required<UserPreferences>>
```

TypeScript will reject this: the actual object has `masterBackend: MasterBackend`, but `Required<UserPreferences>` does not have that field. **Plan 06's defensive hint `masterBackend?: never` on UserPreferences is WRONG** — declaring a field as `never` says "this field must NEVER be present with any value." Spreading a concrete `MasterBackend` value into `never` → type error.

**Correct fix options (planner must pick one, NOT `?: never`):**

1. **Recommended:** Add `masterBackend?: MasterBackend` to `UserPreferences` too (parallel-shape pattern, mirrors `compactPrompt`/`useRagRetrieval`). Update `DEFAULT_PREFERENCES` (`preferences.ts:130-163`) to include `masterBackend: 'baked'`. Resolution stays campaign-only (per PLAN.md Decision 2) — the field on UserPreferences is shape parity, not behavioural.
2. **Alternative:** Change `getSessionMasterPreferences` return type to `Required<CampaignSettings> & { ttsAutoplay: false }` instead of `Required<UserPreferences>`. More honest, but ripples to 6 call sites.
3. **Alternative:** Make the spread explicit, omitting `masterBackend`. Ugly + brittle + requires cast.

**Knock-on effect in plan 07 line 59:** the `(userPrefs as { masterBackend?: MasterBackend })` cast becomes unnecessary after Option 1. Plan 07 must drop the cast.

**Verdict:** NEEDS_REVISION on plan 06 task 2 + plan 07 line 59 (dependent).

### Concern 3: Plan 07 `buildSnapshot` side effects — **PASS**

Read `src/sessions/snapshot.ts:377-470+`. `buildSnapshot(sessionId, userId)` is a **pure DB read**:
- 4 `db.select()` calls against sessions/campaigns/characters/sessionState/combatActors
- Hydration helpers that transform DB rows into engine types (no I/O)
- **No `db.insert`, no `db.update`, no `notifySession`, no telemetry firing.** Verified via grep.

Vault branch can safely call `buildSnapshot`. No fork needed.

### Concern 4: Plan 03 `ToolDef` Ollama compatibility — **PASS**

End-to-end verified:
1. `ToolDef = Anthropic.Messages.Tool` (`types.ts:17`).
2. `Anthropic.Messages.Tool.InputSchema.properties` is `unknown` → any sub-schema (including arrays with `items`) compiles.
3. `anthropicToolToOllama` (`ollama-adapter.ts:91-100`) renames `input_schema` → `parameters` and passes nested schemas through verbatim.
4. Existing engine tools already use `type: 'array', items: { type: 'string' }` in 8+ places (e.g. `engine/tools/index.ts`, `meta-tools.ts`). Ollama acceptance proven by production traffic.

### Concern 5: Plan 08 `--user-jwt` ergonomic risk — **WARNING (acceptable)**

The bench requires extracting a Clerk session JWT from browser dev tools and pasting as `--user-jwt=<token>`. Realistic but friction-y:
- ~30 seconds to extract (devtools → Application → Cookies → `__session`)
- Clerk dev tokens expire in 7 days
- No existing script in codebase uses Clerk auth — plan 08 is the first

**Acceptable.** The plan's design is correct for what it measures (integrated route, REQ-021). Two optional polishes:
1. Document JWT extraction recipe in plan 08's Pre-flight checks (browser steps + 7-day expiry note).
2. Add `--bypass-http` mode that calls `runVaultToolLoop` directly with fixed history. NOT required for Phase 01.

### Concern 6: Plan 05 idempotency — **PASS** (planner correctly fixed research's mistake)

- Source parsing: `markdown.split(/^## (\d+)\. (.+)$/m)` — deterministic.
- `MANUAL_SLUGS` is a `Record<string, string>` (object literal, NOT a `Map`). Used only as lookup, never iterated for output. Insertion-order iteration is guaranteed since ES2015 anyway.
- Output order = source document H2 order. Frontmatter fields written in fixed order. Byte-compare short-circuits.
- 5 idempotency tests in task 8 cover every observable surface.

**H2 count check:** `grep -c "^## " data/master_handbook.md` → **12**, `data/master_world_lore.md` → **8**. Total **20** H2 files. Planner is right; RESEARCH.md (16) was wrong. Plan 05 ships all 20.

### Concern 7: Plan 08 CI/sandbox risk — **PASS**

- `pnpm test` (vitest) scans `tests/**/*.test.{ts,tsx}` only — bench at `scripts/bench-vault-m4.ts` not picked up.
- `pnpm build` runs `tsx src/db/migrate.ts && next build` — does NOT touch the bench.
- `pnpm test:e2e` runs playwright on `tests/e2e/**` — does NOT touch the bench.
- Manual-only invocation via `pnpm bench-vault-m4`. Correctly scoped.

## Cross-cutting findings

### 1. Research-doc claimed colocated tests, but vitest scans only `tests/**/`

RESEARCH.md §6 + §A7 said `*.test.ts` files live next to source. FALSE per `vitest.config.ts:31-40` (scans only `tests/`) and verified: `find src -name "*.test.ts" | wc -l` → 0. All 195 existing tests live under `tests/`.

The planner caught this implicitly — every plan places tests under `tests/<area>/*.test.ts`. **Plans are correct, research was wrong.** Worth recording in plan 09's SUMMARY.md so the Phase 02 planner doesn't re-trip the same error.

### 2. Migration source markdowns coexist with baked path through Phase 01

Plan 05's `data/master_*.md` files stay in place — the baked path still reads them. Phase 01 ships with both source-of-truth conventions coexisting. Phase 03 retires both the source MDs and the baked variants together.

### 3. `MASTER_BACKEND` env var name doesn't collide

Existing envs: `MASTER_PROVIDER`, `MASTER_HISTORY_LIMIT`, `MASTER_PROMPT_BUDGET`, `MASTER_HANDBOOK_*`, `MASTER_HANDBOOK_ULTRA_SLIM`. `MASTER_BACKEND` is unused. Safe.

### 4. Plan 07 vault-branch `console.log` uses fixed prefix `[turn]` — matches existing pattern

Observability preserved.

### 5. Plan 07's `finalizeTurn` signature has unused `campaign` and `snap`

Post-loop block does not reference either. Cosmetic — trim OR keep as forward-looking placeholders for Phase 02 (likely needed for `apply_event` payload construction).

## Final verdict

**NEEDS_REVISION**

### Required changes before execution:

#### 1. Plan 06 task 2 — fix the `masterBackend?: never` workaround (BLOCKER)

Replace `masterBackend?: never` on UserPreferences with one of:
- **Recommended:** Add `masterBackend?: MasterBackend` to UserPreferences too (parallel-shape pattern). Update `DEFAULT_PREFERENCES` to include `masterBackend: 'baked'`. Resolution semantics stay campaign-only.
- Alternative: change `getSessionMasterPreferences` return type to drop `Required<UserPreferences>`.

After the fix, drop the `(userPrefs as { masterBackend?: MasterBackend })` cast in plan 07 line 59.

#### 2. Plan 05 task 7 — fix package.json placement instruction (cosmetic but specific)

Plan 05 says "Place alphabetically between `migrate-legacy-template-sessions` and `lint`." The actual script is `db:fork-legacy` (line 17), not `migrate-legacy-template-sessions` directly, and `lint` is at line 11 (above `db:fork-legacy`). Re-state as "near the other top-level migration scripts; precise position is the implementer's call." Not blocking.

### Recommended polishes (warnings, not blockers):

#### 3. Plan 07 — trim `finalizeTurn` signature (cosmetic)

Drop `campaign` and `snap` from args (unused), OR document them as "reserved for Phase 02 use" in JSDoc.

#### 4. Plan 08 — document Clerk JWT extraction recipe (warning)

Add a concrete recipe (browser devtools steps + 7-day expiry note) to Pre-flight checks. Optional `--bypass-http` mode is Phase 02 polish.

#### 5. Plan 09 SUMMARY.md — record the "colocated tests don't work" finding

Add to "Known limits / follow-ups": vitest scans only `tests/**/` — all new tests go under `tests/`. Protects Phase 02 planner from re-tripping the same RESEARCH.md error.

### Recommended execution order (post-revision)

Dependency-derived order from PLAN.md is correct:

1. **Wave 1 (parallel):** plan 01 (path), plan 06 (settings flag — after revision)
2. **Wave 2 (parallel):** plan 02 (prompt builder), plan 03 (tool defs), plan 05 (migration)
3. **Wave 3:** plan 04 (loop) — depends on 03
4. **Wave 4:** plan 07 (route branch) — depends on 02, 04, 06
5. **Wave 5:** plan 08 (bench)
6. **Wave 6:** plan 09 (rollout + smoke)

Plans 01 and 06 are independent and should be the first PRs. Once 06's type bleed is fixed, the rest is a clean Y-shape converging at plan 07.

### Source files inspected during review

- `.planning/ROADMAP.md`, `REQUIREMENTS.md`, `RESEARCH.md`, `PLAN.md`, all 9 plan files
- `src/app/api/sessions/[id]/turn/route.ts` (line-by-line)
- `src/app/api/campaigns/[id]/settings/route.ts`
- `src/db/schema/{campaigns,users}.ts`
- `src/lib/preferences.ts`
- `src/ai/provider/{types,ollama-adapter}.ts`
- `src/ai/master/tool-loop.ts`
- `src/sessions/snapshot.ts`
- `src/engine/tools/index.ts` (existing array-of-strings tool defs)
- `data/master_handbook.md` + `data/master_world_lore.md` (H2 enumeration via grep)
- `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` (`Tool.InputSchema`)
- `vitest.config.ts` (test-discovery scope)
- `package.json` (scripts inventory)
