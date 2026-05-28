# Design — gemma4 vs qwen3:30b-a3b Model Comparison (Experiment)

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — ready for implementation plan
**Type:** Experiment / decision-support. NOT a production feature.

## Purpose

The operator has `gemma4:latest` pulled on the Mac Mini Ollama and wants a
**decision-grade comparison** against the current vault production model
`qwen3:30b-a3b-instruct-2507-q4_K_M` across three axes: narrative quality,
tool-calling on the vault path, and speed on M4. The outcome is a comparison
table + a recommendation (promote gemma4 to alternative/production, or reject,
with reasoning). This is an experiment — it does NOT add gemma4 as a permanent
production dropdown option.

## Background / constraints

- After Phase 03, production runs the **base model directly** (e.g.
  `qwen3:30b-a3b-instruct-2507-q4_K_M`) + the runtime-built vault system prompt.
  Baked tiers were decommissioned to `dnd-master-plus` only.
- The Settings dropdown (`fetchOllamaModels` in `src/lib/local-services.ts`)
  still filters to `isBakedModel` + `TIER_LABELS` — a legacy-baked-era filter
  that would NOT surface a raw base model like `gemma4:latest`. **This experiment
  deliberately bypasses the dropdown** by setting `campaigns.settings.aiMasterModel`
  directly in the DB, so no production UI code is touched.
- `gemma4` capabilities are **unknown** at design time — it is not a model in the
  assistant's training data (could be a renamed Gemma 3, a custom local build, or
  a recent release). In particular, **native tool-calling support is unverified**.
  The vault write path (`apply_event`) requires native tool calling; if gemma4
  lacks it, the tool-calling axis is decided (fails like gpt-oss:20b did in
  Phase 01) and the comparison reduces to narrative + speed.

## Architecture — three axes gated by a capability probe

```
STEP 0 (gate):  direct Ollama probe — gemma4:latest + one tool definition
                ├─ emits structured message.tool_calls?  → 3-axis comparison
                └─ no / text-only output?                → 2-axis comparison
                                                            (tool-calling = "unsupported",
                                                             documented, not a bug to fix)

AXIS 1 narrative:  spike 014 harness + gemma4 in model-list → side-by-side, 5 scenarios
AXIS 2 speed:      avg_wall / tok-s captured by the spike 014 + 004 harnesses
AXIS 3 tool-vault: [only if gate passes] manual smoke — gemma4 on a test campaign
                   via DB-set aiMasterModel, combat turns, inspect events.md + [ollama] logs
```

No change to `fetchOllamaModels` (production dropdown untouched). gemma4 enters
only through (a) the spike harness model-lists, (b) the DB `aiMasterModel` field
of one test campaign.

## Components

| Axis | Mechanism | New code |
|---|---|---|
| Step 0 — probe gate | `curl` one-shot to Ollama with gemma4 + one tool; read `message.tool_calls`. | 0 (inline bash) |
| Axis 1 — narrative | `run-narrative.ts:9` already reads `process.env.NARRATIVE_MODELS`. Run `NARRATIVE_MODELS="gemma4:latest,qwen3:30b-a3b-instruct-2507-q4_K_M" bash .planning/spikes/014-narrative-quality/run-on-m4.sh` → `comparison-*.md` + avg_wall. | 0 (env override) |
| Axis 2 — speed (warm wall-clock) | spike 004 `run-on-m4.sh` has a hardcoded `CANDIDATES` array. Make it env-overridable: `CANDIDATES=(${SPIKE_CANDIDATES:-<existing defaults>})` so `SPIKE_CANDIDATES="gemma4:latest qwen3:30b-a3b-instruct-2507-q4_K_M" bash run-on-m4.sh` works. Non-breaking (defaults preserved). | ~1 line |
| Axis 3 — tool-vault | Ephemeral `scripts/_set-campaign-model.ts`: `UPDATE campaigns SET settings = jsonb_set(settings,'{aiMasterModel}','"gemma4:latest"') WHERE id = <test campaign>`. Then manual smoke (combat turns), inspect `events.md` + `[ollama]` logs. Reset to qwen3 after. | ~30 LOC ephemeral (deleted after) |

The only committable production edit is making spike 004 `CANDIDATES`
env-overridable — a genuine reusability improvement, not gemma4-specific.

## Execution flow

1. **[operator]** Wake the Mac Mini → `tailscale status` shows the peer `active`.
2. **[assistant]** Probe gate: gemma4 + tool → tool_calls present? yes/no. Records which branch the comparison takes.
3. **[operator, on M4]** `NARRATIVE_MODELS="gemma4:latest,qwen3:30b-a3b-instruct-2507-q4_K_M" bash .planning/spikes/014-narrative-quality/run-on-m4.sh` → `comparison-*.md`.
4. **[operator, on M4]** `SPIKE_CANDIDATES="gemma4:latest qwen3:30b-a3b-instruct-2507-q4_K_M" bash .planning/spikes/004-m4-validation/run-on-m4.sh` → warm wall-clock table.
5. **[assistant]** Set `aiMasterModel=gemma4:latest` on the test campaign (DB).
6. **[operator]** Smoke: 3 turns (1 narrative + 2 combat with apply_event) on gemma4.
7. **[assistant]** Read `events.md` + `ai_usage` timing; then reset the test campaign to qwen3.
8. **[assistant]** Final comparison table: narrative (verdict) | tool-calling (pass/fail) | tok-s | wall-clock + recommendation.

## Comparison criteria (what "promotes" gemma4)

- **Narrative:** coherent Italian prose, ≥ parity with qwen3 in the side-by-side (operator's subjective verdict).
- **Tool-calling:** emits `apply_event` with valid UUIDs, lenient discovery works, no infinite loops (objective pass/fail). If the Step 0 gate already failed, this axis is "unsupported" and the comparison is narrative + speed only.
- **Speed:** warm wall-clock comparable to or better than qwen3 (~8s baseline from the Phase 03 M4 bench) on M4.

The deliverable is a comparison table + a recommendation: gemma4 promoted to
alternative/production (which would then justify a separate follow-up to surface
it in the dropdown), or rejected with reasoning.

## Out of scope

- Modifying `fetchOllamaModels` / the production Settings dropdown (only relevant
  if gemma4 is later promoted — a separate piece of work).
- Re-running the full Phase 03 `bench-phase-03-m4` aggregator (spike 011 long-session
  is known-broken; this experiment uses 014 + 004 directly).
- Baking gemma4 into a `dnd-master-*` tier (Phase 03 decommissioned the baked
  approach; production uses base models + runtime vault prompt).
- Permanent test infrastructure — the DB-set script and smoke are throwaway.

## Risk notes

- **Mac Mini availability:** the box sleeps after ~1h idle and has gone offline
  repeatedly during this project. Every operator step is gated on `tailscale
  status` showing the peer active. The probe (Step 0) is the cheapest reachability
  check and runs first.
- **gemma4 tool-calling unknown:** the Step 0 gate exists precisely so we don't
  build the tool-vault smoke before confirming the capability. Fail-fast.
- **Test campaign mutation:** Axis 3 sets `aiMasterModel` on a real campaign's
  settings and writes real events to its `events.md`. Use a disposable test
  campaign (or reset to qwen3 + roll back events.md after), never a campaign with
  data worth keeping.
