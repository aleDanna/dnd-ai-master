# Vault-as-LLM-Memory Migration — Risk Register

**Status:** Investigation / Exploration
**Date:** 2026-05-22
**Companion doc:** [2026-05-22-vault-llm-wiki-design.md](./2026-05-22-vault-llm-wiki-design.md)

Risks ranked by **product impact × likelihood** for the single-developer, single-user, local-LLM scenario of this project. Severities below assume the design as proposed (vault replaces all knowledge + dynamic state + tool contract).

---

## Risk summary table

| # | Risk | Severity | Likelihood | Net |
|---|---|---|---|---|
| R1 | Tool discovery unreliable on local models (worse on M4-realistic 8b/24b models) | High | High | **Critical** |
| R2 | Wall-clock latency regression (no real gain) | High | Low-Medium (M4) | **High** |
| R3 | Cross-file consistency loss on multi-file mutations | High | Medium | **High** |
| R4 | Concurrent-write silent corruption | High | Low (single-agent) | Medium |
| R5 | Correction-blindness / narrative eviction | Medium | High | **High** |
| R6 | Migration complexity / data loss during cutover | High | Medium | **High** |
| R7 | Backup & disaster-recovery regression | Medium | Medium | Medium |
| R8 | Vault size growth degrading reads over time | Medium | Medium | Medium |
| R9 | Schema validation lost (YAML vs drizzle types) | Medium | High | **High** |
| R10 | Path-convention drift / collision | Low | Medium | Low |
| R11 | Index.md / TOC staleness | Medium | High | **High** |
| R12 | Tool-contract drift (new tool not discovered) | Medium | Medium | Medium |
| R13 | SSD budget (256 GB on M4): vault writes + git history + Ollama models compete | Medium | Medium | Medium |

---

## Critical risks (deep dive)

### R1 — Tool discovery unreliable on local models

**Description.** The design relies on the LLM reading `/tools/index.md` and `/tools/<name>.md` *before* invoking a tool. Karpathy-style patterns were validated on Claude-class models with strong tool discipline. Local models (mistral 24b, qwen3 8b, qwen3 30b-a3b) may:
- Hallucinate tool calls with wrong schema without reading the schema file
- Skip the index lookup and try tools by name
- Lose tool list context across long turns (KV-cache eviction)

If this fails, every saved token of "lazy tool contract" turns into a runtime error or worse — a silently corrupted state mutation.

**M4-specific aggravation.** The Mac Mini M4 production target has 32GB RAM and 256GB SSD. Realistic local models under that budget are qwen3:8b (~5 GB) and mistral:24b Q4 (~14 GB). qwen3:30b sits at the hard RAM limit with no room for the embedder. The smaller the model, the less tool-call discipline it shows in practice. Karpathy's pattern was demonstrated on Claude-class — the gap between Claude and qwen3:8b on "follow a 3-step lookup protocol" is the largest source of project risk.

**Severity.** High. Project viability hinges on this. The 15K-tok savings on TOOL_CONTRACT is *the* reason to do the migration; if you must keep it inline for local models, the gain shrinks from 66% to ~25% (baked) and the wall-clock M4 improvement drops from ~50% to ~20% — possibly below the threshold worth migrating for.

**Likelihood.** High. No public evidence the pattern works reliably at qwen3:8b/mistral:24b scale. The "look it up first" discipline is a Claude/GPT-class behavior in current literature.

**Mitigation.**
- **Pre-implementation gate:** run a smoke test (10-20 turns) with each target model where the system prompt says "before calling X, you MUST read `/tools/X.md`". Measure compliance rate. <90% = abort or fallback.
- **Fallback design:** keep TOOL_CONTRACT_SLIM (218 tok) inline + lazy-load only *examples* and *advanced schemas* in `/tools/`. Compromise: floor moves from 3K to ~3.2K, but tool calls are anchored.
- **Hardcoded tool registry:** validate every tool call against a JSON schema server-side; reject malformed calls with a structured error pointing to `/tools/<name>.md` so the LLM self-corrects.

**Detection signals.** Track `tool_call_rejected` rate. Spike post-migration > baseline = R1 materialized.

---

### R2 — Wall-clock latency regression

**Description.** The design assumes prefill savings (-60% est.) outweigh the cost of +1-2 extra tool round-trips per turn. But each round-trip incurs:
- Decode of ~50-200 tok of "I need to look up X" reasoning
- New prefill that *re-processes* the growing `tool_result` accumulator
- Network/IPC overhead in the tool loop

LlamaIndex's 2026 benchmark explicitly warns: filesystem agents *can lose* on wall-clock at small scale.

**Severity.** High. Latency is the *primary motivation* for this migration. If wall-clock doesn't improve, the entire effort is wasted (and we add risks R1/R3/R6 for nothing).

**Likelihood.** Medium-Low on M4 (lower than M5 Pro). The math *favors* the vault more strongly on M4 because:
- Prefill on M4 is ~2-2.5× slower per token than M5 Pro (bandwidth 120 vs 307 GB/s)
- Saving 5K-6K static tokens translates to ~10-12s saved per turn on M4 vs ~4-5s on M5 Pro
- The tool-loop overhead is the same in absolute call count, so its *relative* cost shrinks when prefill dominates
- LlamaIndex's "wall-clock loss" warning applies more to fast-LLM-server scenarios where prefill is cheap. On M4, prefill dominates wall-clock decisively.

**Mitigation.**
- **Empirical spike before commitment.** Mandatory: build a throw-away prototype that handles just `/handbook/spells/` and measure 5 realistic turns end-to-end on M5 Pro. Compare to current `ai_usage.eval_duration_ms + prompt_eval_duration_ms`.
- **KV-cache anchoring.** Ensure the static portion of the prompt is *truly stable* across turns so Ollama's prefix-cache hits. Any string differing per-turn (timestamps, random IDs) before the dynamic block kills the cache.
- **Batch tool calls.** If LLM can emit multiple `read_vault` calls in parallel, single round-trip handles N reads — closes the gap with bulk RAG.

**Detection signals.** Compare `prompt_eval_duration_ms` and total turn duration in `ai_usage` before/after, on a controlled set of campaigns.

---

### R3 — Cross-file consistency loss

**Description.** A single in-game action commonly mutates multiple files: a fireball hit updates `character/<pc>.md` (HP), `session/<n>.md` (event), maybe `world/<location>.md` (broken environment), and the action is logged. With per-file atomicity but no transaction, a crash mid-sequence leaves the vault in an inconsistent state.

**Severity.** High. Game state corruption manifests as "Claude thinks the goblin is alive but the PC's HP says they killed it" — confusing and frustrating, hard to debug, breaks immersion.

**Likelihood.** Medium. Crashes are rare but not zero (process kill, disk full, OS sleep mid-write). More importantly, *logical* inconsistency from partial application is common in iterative LLM work.

**Mitigation.**
- **events.md is source of truth.** Every mutation is appended to `events.md` *first* (single atomic append). File mutations are derived projections. On startup, replay events from last-known-good state.
- **Mutation grouping in tool design.** Define `apply_action({event_type, mutations: [...]})` as a single tool call. The handler appends one event, then applies all mutations transactionally (rename(2) for each, with rollback on failure).
- **Recovery script.** A `vault-rebuild` script that replays `events.md` and regenerates all derived files. Acts as both DR tool and consistency check.

**Detection signals.** Mismatch between `events.md` tail and `character/<pc>.md` frontmatter on session resume.

---

### R5 — Correction-blindness / narrative eviction

**Description.** Published post-mortems ([Memory Vault post-mortem](https://medium.com/@vivioo.io/your-ai-agent-keeps-forgetting-76d7bcefacf0), [3000-op test](https://dev.to/mahendra4/i-tested-3000-llm-agent-memory-operations-heres-what-i-found-17pc)) report 39-46% memory failure rates when corrections are stored as regular notes among other content. Examples:
- User says "actually that NPC died last session" → LLM logs it but ignores it next turn because the original "alive NPC" note is closer to the path used.
- A rule clarification ("we house-rule that crits double damage dice only, not modifier") gets buried in the campaign body.

**Severity.** Medium-High. Players notice when the DM forgets corrections. Repeatedly forgetting kills immersion.

**Likelihood.** High. This is a documented systematic failure mode of vault-as-memory, not a fluke.

**Mitigation.**
- **Dedicated `corrections.md` per campaign.** Always read top-of-prompt. Frontmatter ordering: most-recent-first. Capped size (latest 20 corrections).
- **Hard system-prompt rule:** "Before responding, scan `/campaigns/<id>/corrections.md`. If any correction applies to the current turn, honor it over any other source."
- **Tool design:** `add_correction(text, scope, expires)` separate from regular state mutation. Makes the LLM explicit about flagging "this is a correction, not regular content".

**Detection signals.** Manual: when the player says "I told you this already". Programmatic: log when `add_correction` is invoked vs when relevant correction was actually surfaced in subsequent turns.

---

### R6 — Migration complexity / data loss during cutover

**Description.** Existing campaigns in Postgres (`campaigns`, `characters`, `session_state`) need to be exported into vault structure without losing data. Schema is rich (drizzle types, JSON columns for inventory/spells); markdown frontmatter is lossy by default. One bad export = lost history of a long-running campaign.

**Severity.** High. User has running campaigns; losing them is data loss.

**Likelihood.** Medium. Export scripts are routine, but converting structured types (e.g., spell slots as `{1: 3, 2: 2, 3: 1, ...}` nested) to YAML is fiddly and error-prone.

**Mitigation.**
- **Dual-write coexistence period.** Run new vault writes alongside Postgres writes for N weeks. Postgres remains source of truth. Validate vault state matches DB state on session resume. Only flip the source-of-truth flag after sustained agreement.
- **Snapshot before cutover.** `pg_dump` + `tar` of vault baseline immediately before flipping source-of-truth. Rollback plan: restore DB, set flag back, problem solved.
- **Round-trip property tests.** Property test: random `EngineState` JSON → export to vault → re-import → assert equal. Catches type/serialization bugs before they touch real data.

**Detection signals.** Dual-write divergence alert. Property test failures.

---

## Medium risks (concise)

### R4 — Concurrent-write silent corruption
- **Mitigation:** single-agent invariant enforced at API layer (`/api/sessions/:id/turn` holds an in-process mutex per campaign-id). Multi-process scaling deferred (not in scope).
- **Detection:** `events.md` integrity check on session resume.

### R7 — Backup & disaster recovery regression
- **Mitigation:** vault is a git repo. `commit-on-events.md-append` (one commit per turn). Push to private GitHub or local-mirror nightly. Bonus: full version history of every campaign for free.
- **Detection:** scheduled `git log` sanity check.

### R8 — Vault growth degrading reads
- **Mitigation:** session bodies capped at ~5K tok. Older sessions get a "summary frontmatter" + offloaded body to `sessions/<n>-full.md`. LLM reads summary by default, full only on request.
- **Detection:** track average file size; alert on outliers.

### R9 — Schema validation lost (YAML vs drizzle)
- **Mitigation:** define Zod schemas for every frontmatter shape. Validate on read and write. Use `zod-yaml` or custom parser. This restores compile-time-ish safety at runtime.
- **Detection:** Zod parse failures logged.

### R10 — Path-convention drift / collision
- **Mitigation:** centralize path-building in `src/vault/paths.ts`. Never construct paths inline. Reserved characters policy. Linter.
- **Detection:** path-builder unit tests.

### R11 — Index.md staleness
- **Mitigation:** `index.md` files are *regenerated* from filesystem state on every mutation (not hand-edited by LLM). A `regenerateIndex(campaignId)` runs after every `apply_action`. Cheap (~5ms for a small campaign).
- **Detection:** index sanity check on session resume: enumerate dir, diff against index.

### R12 — Tool-contract drift (new tool not discovered)
- **Mitigation:** when a new tool is added to `/tools/`, bump a `tools_version` field in the system prompt context. LLM is instructed to re-read `/tools/index.md` if `tools_version` changes.
- **Detection:** tool registration tests.

### R13 — SSD budget (256 GB on M4)
- **Description.** M4 production target has 256 GB SSD. macOS + apps + Ollama models (each ~5-20 GB) already eat 80-120 GB. A growing vault + git history per turn (R7 mitigation) can add 100s of MB/month for a heavy player. Multiple baked Ollama variants compound the pressure.
- **Mitigation:** The migration *itself* eases this by removing the need for per-model baked variants (handbook/lore/SRD live in vault, not in the modelfile). Pick a small set (2-3) of generic Ollama models. Periodic git GC on the vault repo. Older session summaries offloaded to compressed `.md.gz` accepted by `read_vault`.
- **Detection:** disk usage monitor; alert at 80% capacity.

---

## Risk-gated decision points

These are explicit *go/no-go* gates before committing to the migration:

| Gate | Condition | Action if fail |
|---|---|---|
| **G1** | Empirical spike shows ≥40% wall-clock improvement **on Mac Mini M4** (R2) | Abort migration; baked variants are good enough |
| **G2** | Tool discovery compliance ≥90% on qwen3:8b AND mistral:24b (R1) | Drop lazy tool contract; keep TOOL_CONTRACT_SLIM inline (drops gain to ~25%) |
| **G3** | Dual-write divergence rate <0.1% over 2 weeks (R6) | Postpone cutover; debug export until clean |
| **G4** | Round-trip property tests pass for all campaign types (R6) | Block cutover; fix serialization bugs |
| **G5** | DR rehearsal: simulate vault corruption, restore from git, verify state (R7) | Block cutover until DR procedure validated |

**Recommendation: do not write a single line of migration code before G1 and G2 are answered empirically — and both gates MUST be measured on the M4, not the M5 Pro dev machine.** A green light on M5 Pro means nothing if M4 can't show the same improvement (and vice versa: a marginal M5 Pro gain may be a strong M4 gain because of the bandwidth penalty multiplier).

---

## Risks NOT in scope (deferred)

- **Multi-user / multi-tenant** — single-developer project; revisit if SaaS path emerges.
- **Multi-agent concurrent campaigns** — single-agent assumption holds for foreseeable future.
- **Vault encryption at rest** — file permissions sufficient on personal machines.
- **Cross-machine sync conflicts** — git handles this if vault is in a git repo; manual conflict resolution acceptable.
