# Plan 08: M4 Benchmark Runner (Manual, Not CI-Gated)

**Phase:** 01-vault-read-path
**Status:** Pending
**Depends on:** 07-turn-route-branch (the integrated path that the bench exercises)
**Estimated diff size:** ~200 LOC source / 2 files

## Goal

Ship `scripts/bench-vault-m4.ts` — a runner the developer invokes manually on the Mac Mini M4 (production target hardware per REQ-020) to validate the warm wall-clock target. It exercises the integrated Next.js turn endpoint (NOT a standalone Ollama harness — the spike's harness is preserved in `.claude/skills/spike-findings-dnd-ai-master/sources/004-m4-validation/`; this script measures the production path end-to-end).

It runs 5 fixed rules-lookup turns from the ROADMAP Phase-01 success criterion ("New E2E test covers `MASTER_BACKEND=vault` happy path on 5 rules-lookup turns") and reports per-turn `prompt_eval_duration_ms`, `eval_duration_ms`, total wall-clock + `prompt_eval_count` by querying `ai_usage` for the test session.

**Not a CI gate.** CI runs on M5 Pro dev hardware where MoE-A3B routing makes the model FASTER than M4 — measuring there doesn't validate the M4 target (REQ-020 mandates measurement on production hardware). The script prints results; the developer inspects them. Manual workflow:

```
ssh m4
cd dnd-ai-master
pnpm dev                            # in one terminal
pnpm bench-vault-m4 --session=<id>  # in another
```

## Requirements satisfied

- **REQ-020** Production target hardware: Mac Mini M4 — script's design assumes manual M4 invocation.
- **REQ-021** Warm wall-clock per turn < 10s on M4 — script measures this directly and asserts in its output.

## Files touched

| File | Action | Why |
|---|---|---|
| `scripts/bench-vault-m4.ts` | NEW | The benchmark runner. |
| `package.json` | EDIT | Add `"bench-vault-m4": "tsx scripts/bench-vault-m4.ts"`. |

## Tasks

1. **Create `scripts/bench-vault-m4.ts`.** Structure:

   - CLI flags (parsed via the existing repo pattern — most scripts in `scripts/` use bare `process.argv` slicing; mirror `scripts/db-audit.ts` style):
     - `--session=<id>` (REQUIRED): session UUID to send turns to. Created beforehand by the dev (the script doesn't create campaigns/sessions — that's out of scope).
     - `--host=<url>` (default `http://localhost:3000`): the dev's Next.js base URL.
     - `--user-jwt=<token>` (REQUIRED): Clerk session token — the dev pastes their dev-mode token. The script sends it as a `Cookie` header (`__session=<jwt>`) — the existing turn route reads Clerk session from cookies.
       - **How to extract the JWT on M4 dev box:** open the app in Chrome/Firefox while signed in via Clerk dev mode → Open devtools (⌘⌥I) → Application tab → Storage → Cookies → `http://localhost:3000` → copy the value of the `__session` cookie. Paste it into the terminal as `--user-jwt=<long-string>`. The token expires after ~7 days in Clerk dev mode — if you see `401 Unauthorized` from the bench script, the token is stale; re-extract.
       - **Why not bypass HTTP and call `runVaultToolLoop` directly?** The bench measures the integrated route latency (REQ-021 — production wall-clock). A loop-direct bench (like spike 003's pattern) measures only the LLM-loop cost and would under-report by ~50-200ms per turn (auth + DB hydration + tool-result persistence excluded). The integrated bench is the honest measurement. A `--bypass-http` mode that exercises only the loop is acceptable as a Phase 02 polish for quick smoke iteration but is NOT required for Phase 01.
     - `--turns=<n>` (default 5): how many turns to send.
     - `--out=<path>` (default `./bench-vault-m4-<ts>.json`): result file.

   - 5 fixed prompts (the Phase-01 success-criterion happy path), all in Italian to match the user-language convention:
     ```
     const PROMPTS = [
       'Quanto danno fa Fireball al livello 5?',
       'Quali sono le condizioni che un Paladino può rimuovere con Lay on Hands?',
       'Come funziona il vantaggio in 5e? Quando si applica e quando si annulla?',
       'Quanta velocità ha un Tiefling? E cosa fa la sua resistenza al fuoco?',
       'Quante slot di livello 3 ha uno Wizard di livello 5?',
     ];
     ```
     5 prompts — the ROADMAP-specified count. Mix of mechanics (Fireball, slots), abilities (Lay on Hands, advantage), and race traits (Tiefling) to exercise different vault dirs (`/handbook/spells/`, `/handbook/classes/`, `/handbook/rules/` are all reserved-empty in Phase 01 — the model falls back to pretrained knowledge per Decision 3 of the SRD section in RESEARCH.md, validated 4/5 keyword on Fireball-class).

   - **Cold turn (turn 1):** before sending turn 1, call `POST <host>/api/admin/ollama-unload` if such a route exists — otherwise skip cold-warm distinction and label all turns as "warm" (per spike 003, cold is dominated by model load and we're not trying to validate cold path in Phase 01). Add a comment: cold-turn measurement deferred to Phase 03's full M4 sweep. The bench focuses on warm wall-clock.

   - **Per turn:** the runner:
     1. Records `t0 = Date.now()`.
     2. POSTs `<host>/api/sessions/<id>/turn` with `{ message: <prompt> }` + auth cookie.
     3. Waits for the SSE response (the turn route returns 202; results stream via SSE). Either:
        - **Option A:** subscribe to `GET <host>/api/sessions/<id>/stream` and consume until the `message` event arrives (signals turn-complete); compute `t1 - t0`.
        - **Option B (simpler, recommended):** poll `ai_usage` via a thin direct query — the runner has DB access since it's a server-side script. Read the most recent `ai_usage` row for this session with `endpoint='master'` (filter by inserted_at > t0). When the row appears, the turn is done.
        - Pick Option B — it's deterministic and avoids SSE plumbing. Direct DB query against `db.select().from(aiUsage).where(...).orderBy(desc(aiUsage.createdAt))`.
     4. Records: wall-clock = poll-arrival - t0; `prompt_eval_count`; `prompt_eval_duration_ms`; `eval_duration_ms`; `load_duration_ms`. Convert ns→ms where applicable (the schema is already in ms per `usage.ts`).
     5. Logs a line: `[turn N] "${prompt.slice(0, 40)}…" wall=${wallMs}ms prompt_eval=${ptok} tok eval=${etok} ms`.

   - **Summary block** at the end:
     ```
     ────────────────────────────────────────────────────
      VAULT PATH — M4 BENCHMARK
     ────────────────────────────────────────────────────
     turn  wall_ms  ptok    etok    pe_ms   ev_ms   load_ms
       1    XXXX     X.XK    X.XK   XXX     XXX     XXX
       2     ...
       ...
     ────────────────────────────────────────────────────
     mean wall_ms:     XXXX (target < 10000)
     median wall_ms:   XXXX
     max wall_ms:      XXXX
     mean prompt_eval: X.XK (vs baked baseline ~8.8K)
     REQ-021 gate:     ✓ PASS / ✗ FAIL  (max wall < 10s)
     ────────────────────────────────────────────────────
     ```

   - **JSON output** written to `--out`: array of per-turn objects with `{ turn, prompt, wallMs, promptEvalCount, evalCount, promptEvalMs, evalMs, loadMs }`. The dev can grep this for follow-up analysis.

   - **Exit code:** 0 always (this is a measurement tool, not a CI gate). A `--strict` flag could be added later to exit-1 on REQ-021 failure, but Phase 01 omits — the dev reads the output and decides.

2. **Pre-flight checks at script start:**
   - Assert the target session's campaign has `masterBackend: 'vault'` set. Query `campaigns.settings` directly; if `vault` not set, print a clear error and exit 2.
   - Assert Ollama is reachable: `GET ${OLLAMA_BASE_URL}/api/tags` → 200. If unreachable, error + exit 2.
   - Assert `data/vault/handbook/index.md` exists (the migration has been run). If missing, instruct the dev to run `pnpm migrate-handbook-to-vault` first.

3. **Wire `package.json`:** add `"bench-vault-m4": "tsx scripts/bench-vault-m4.ts"` to scripts (alphabetical-ish placement; near `build-rag-index`).

4. **No test for this script.** Bench runners that depend on a running Next.js + Ollama + DB aren't unit-testable in isolation, and the script's correctness is verified by its own output (the dev reads the table). Test budget is better spent elsewhere in Phase 01.

5. **Document usage in the script's top comment.** A ~15-line header explaining:
   - Why M4-only (hardware-specific MoE perf characteristics).
   - The 4 prerequisites (session, JWT, vault flag set, vault migrated).
   - The 5 prompts and what they exercise.
   - REQ-021 reference.
   - Pointer to `.claude/skills/spike-findings-dnd-ai-master/references/performance.md` for the spike-004 baselines (warm 3.78s, baked 26.05s on this same model).

## Verification

- Command: `pnpm typecheck` → clean (the script compiles).
- Command: `pnpm bench-vault-m4 --session=<missing>` → error 2 (pre-flight catches missing session).
- Behaviour (manual, on M4 only): `pnpm bench-vault-m4 --session=<real> --user-jwt=<jwt>` → produces 5-row table + summary. Manual inspection: max wall_ms should be < 10000.
- File check: `bench-vault-m4-<ts>.json` produced after a successful run.
- Cross-reference: `ai_usage` rows for the bench session show `prompt_eval_count` in the 3-5K range, matching the table output.

## Open questions

None — script is deliberately scoped to measurement only, not CI gating.
