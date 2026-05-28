# gemma4 vs qwen3 Model Comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare `gemma4:latest` against the Phase 03 production model `qwen3:30b-a3b-instruct-2507-q4_K_M` across narrative quality, vault tool-calling, and M4 speed, producing a comparison table + promote/reject recommendation.

**Architecture:** Reuse the spike 014 (narrative) + spike 004 (warm wall-clock) harnesses via env-overridable model lists, plus a manual vault smoke on the existing One Piece test campaign (DB-set `aiMasterModel`). A Step-0 capability probe gates the tool-calling axis — if gemma4 lacks native tool calling, that axis is recorded "unsupported" and the comparison reduces to narrative + speed.

**Tech Stack:** Ollama (Mac Mini M4 via Tailscale funnel), bash spike harnesses, tsx/drizzle for DB set, existing vault path (`apply_event`, `events.md`, projector).

**Hardware gate:** Every operator step requires the Mac Mini online (`tailscale status` shows peer `active`). The box sleeps after ~1h idle. Wake it before starting.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `.planning/spikes/004-m4-validation/run-on-m4.sh` | warm wall-clock harness | Modify — make `CANDIDATES` env-overridable |
| `scripts/_set-campaign-model.ts` | throwaway DB helper to set `aiMasterModel` on a campaign | Create (deleted in Task 6) |
| `.planning/spikes/014-narrative-quality/run-narrative.ts` | narrative harness | No change (already reads `NARRATIVE_MODELS` env) |
| `docs/superpowers/specs/2026-05-28-gemma4-model-comparison-design.md` | design reference | No change (read-only) |

No production code is modified. The single committable edit is the env-overridable `CANDIDATES` array (reusability improvement, non-breaking).

---

## Task 1: Make spike 004 CANDIDATES env-overridable

**Files:**
- Modify: `.planning/spikes/004-m4-validation/run-on-m4.sh:38-44`

- [ ] **Step 1: Apply the edit**

Replace the hardcoded array (lines 38-44):

```bash
CANDIDATES=(
  "mistral-small3.2:24b-instruct-2506-q4_K_M"
  "mistral-small3.2:24b"
  "qwen3:30b-a3b-instruct-2507-q4_K_M"
  "qwen3:30b-a3b-instruct-2507"
  "qwen3:30b-a3b"
)
```

with an env-overridable form (defaults preserved when `SPIKE_CANDIDATES` is unset/empty):

```bash
# Candidate models for M4 production. Order matters: smallest first so
# we see fast feedback before committing to the longer 30b runs.
# Override with SPIKE_CANDIDATES="modelA modelB" (space-separated) to run an
# ad-hoc subset — e.g. a single-model A/B comparison. Defaults below are the
# spike-004 candidate set.
if [ -n "${SPIKE_CANDIDATES:-}" ]; then
  # shellcheck disable=SC2206
  CANDIDATES=(${SPIKE_CANDIDATES})
else
  CANDIDATES=(
    "mistral-small3.2:24b-instruct-2506-q4_K_M"
    "mistral-small3.2:24b"
    "qwen3:30b-a3b-instruct-2507-q4_K_M"
    "qwen3:30b-a3b-instruct-2507"
    "qwen3:30b-a3b"
  )
fi
```

- [ ] **Step 2: Verify default behavior is unchanged (no env var)**

Run: `bash -n .planning/spikes/004-m4-validation/run-on-m4.sh && echo "syntax ok"`
Expected: `syntax ok`

Then dry-check the default array expands to 5 entries:
Run: `SPIKE_CANDIDATES="" bash -c 'source <(sed -n "37,52p" .planning/spikes/004-m4-validation/run-on-m4.sh); printf "%s\n" "${CANDIDATES[@]}" | wc -l'`
Expected: `5`

- [ ] **Step 3: Verify override works**

Run: `SPIKE_CANDIDATES="gemma4:latest qwen3:30b-a3b-instruct-2507-q4_K_M" bash -c 'source <(sed -n "37,52p" .planning/spikes/004-m4-validation/run-on-m4.sh); printf "%s\n" "${CANDIDATES[@]}"'`
Expected:
```
gemma4:latest
qwen3:30b-a3b-instruct-2507-q4_K_M
```

- [ ] **Step 4: Commit**

```bash
git add .planning/spikes/004-m4-validation/run-on-m4.sh
git commit -m "feat(spike-004): make CANDIDATES env-overridable via SPIKE_CANDIDATES

Allows ad-hoc model subsets for A/B comparisons (e.g. gemma4 vs qwen3)
without editing the harness. Defaults preserved when unset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Step-0 capability probe (tool-calling gate)

**Files:** none (inline bash, run by assistant once Mac Mini is up)

**Precondition:** `tailscale status` shows `alessios-mac-mini` peer `active`.

- [ ] **Step 1: Verify Ollama reachable + gemma4 present**

```bash
TOKEN="<LOCAL_LLM_TOKEN from .env.local>"
curl -sS --max-time 8 -o /dev/null -w "healthz %{http_code}\n" \
  https://alessios-mac-mini.tailb09e44.ts.net/healthz
curl -sS --max-time 8 -H "Authorization: Bearer $TOKEN" \
  https://alessios-mac-mini.tailb09e44.ts.net/ollama/api/tags \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['name'] for m in d['models'] if 'gemma' in m['name'].lower()])"
```
Expected: `healthz 204` + a list containing `gemma4:latest`.

- [ ] **Step 2: Probe tool-calling capability**

```bash
TOKEN="<LOCAL_LLM_TOKEN>"
curl -sS --max-time 60 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "model":"gemma4:latest",
    "messages":[
      {"role":"system","content":"You are a D&D Master. To record damage you MUST call the apply_event tool. Do not narrate."},
      {"role":"user","content":"Luffy takes 5 damage. Record it."}
    ],
    "stream":false,
    "tools":[{"type":"function","function":{"name":"apply_event","description":"Record a game-state mutation","parameters":{"type":"object","properties":{"type":{"type":"string"},"payload":{"type":"object"}},"required":["type","payload"]}}}],
    "options":{"num_predict":120}
  }' \
  https://alessios-mac-mini.tailb09e44.ts.net/ollama/api/chat > /tmp/gemma-probe.json
python3 -c "import json; d=json.load(open('/tmp/gemma-probe.json')); m=d.get('message',{}); print('tool_calls:', json.dumps(m.get('tool_calls',[]))[:400]); print('content[:200]:', repr(m.get('content','')[:200])); print('eval_count:', d.get('eval_count'))"
```

- [ ] **Step 3: Record the gate verdict**

Expected one of:
- **GATE PASS** — `tool_calls` is a non-empty array with `function.name == "apply_event"`. → run the full 3-axis comparison (Tasks 3, 4, 5).
- **GATE FAIL** — `tool_calls` is `[]` and `content` is narrative text. → record tool-calling axis as "unsupported (no native tool calling)", SKIP Task 5, run only Tasks 3 + 4.

Write the verdict into a scratch note for Task 6 (e.g. append to `/tmp/gemma-comparison-notes.md`).

---

## Task 3: Narrative comparison (Axis 1) — operator-run on M4

**Files:** none (env-override run; `run-narrative.ts` already reads `NARRATIVE_MODELS`)

**Precondition:** Mac Mini online; run ON the Mac Mini (decision-grade M4).

- [ ] **Step 1: Run the narrative harness with gemma4 + qwen3**

On the Mac Mini terminal:
```bash
cd ~/dnd-ai-master
git pull origin main
NARRATIVE_MODELS="gemma4:latest,qwen3:30b-a3b-instruct-2507-q4_K_M" \
  bash .planning/spikes/014-narrative-quality/run-on-m4.sh
```
Expected: per-model per-scenario lines (`wall=...ms ... chars=...`) for 5 scenarios × 2 models, then a wall-clock summary, then `Markdown report: .../comparison-<ts>.md`.

- [ ] **Step 2: Capture the report path + avg wall-clock**

Run: `ls -t .planning/spikes/014-narrative-quality/results/comparison-*.md | head -1`
Paste the path + the "Wall-clock summary" block back to the assistant.

---

## Task 4: Warm wall-clock comparison (Axis 2) — operator-run on M4

**Files:** none (uses Task 1's env-overridable CANDIDATES)

**Precondition:** Task 1 committed + pulled on Mac Mini; Mac Mini online.

- [ ] **Step 1: Run spike 004 with gemma4 + qwen3 only**

On the Mac Mini terminal:
```bash
cd ~/dnd-ai-master
SPIKE_CANDIDATES="gemma4:latest qwen3:30b-a3b-instruct-2507-q4_K_M" \
  bash .planning/spikes/004-m4-validation/run-on-m4.sh
```
Expected: pre-flight passes (both models present), compliance sweep + wall-clock comparison table for the 2 models.

- [ ] **Step 2: Capture the WARM wall-clock + compliance numbers**

Paste the "WALL-CLOCK COMPARISON" table + the per-model `ok=N/5` compliance counts back to the assistant.

---

## Task 5: Vault tool-calling smoke (Axis 3) — GATED on Task 2 PASS

**Files:**
- Create: `scripts/_set-campaign-model.ts` (throwaway; deleted in Task 6)

**Precondition:** Task 2 gate = PASS. Mac Mini online. `pnpm dev` running (M5 Pro or Mac Mini) pointed at the Mac Mini Ollama. One Piece campaign (`3ef630db`) is the test target (currently model=qwen3, vault+mutations on).

- [ ] **Step 1: Create the throwaway model-set script**

Create `scripts/_set-campaign-model.ts`:
```ts
import './_env-loader';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';

// Usage: pnpm tsx scripts/_set-campaign-model.ts <campaign-id-prefix> <model-slug>
async function main() {
  const [prefix, model] = process.argv.slice(2);
  if (!prefix || !model) {
    console.error('Usage: tsx scripts/_set-campaign-model.ts <campaign-id-prefix> <model-slug>');
    process.exit(2);
  }
  const [row] = (await db.execute<{ id: string; name: string; settings: Record<string, unknown> }>(sql`
    SELECT id::text AS id, name, settings FROM campaigns WHERE id::text LIKE ${prefix + '%'} AND deleted_at IS NULL LIMIT 2
  `)).rows;
  if (!row) { console.error(`No campaign matches prefix ${prefix}`); process.exit(2); }
  const next = { ...row.settings, aiMasterModel: model };
  await db.update(campaigns).set({ settings: next, updatedAt: new Date() }).where(eq(campaigns.id, row.id));
  console.log(`✓ ${row.name} (${row.id.slice(0,8)}) aiMasterModel → ${model}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Record One Piece's current model (for reset)**

Run: `pnpm tsx scripts/_set-campaign-model.ts 3ef630db qwen3:30b-a3b-instruct-2507-q4_K_M`
(This is a no-op set confirming the baseline; note the output shows the campaign name.)
Expected: `✓ One Piece (3ef630db) aiMasterModel → qwen3:30b-a3b-instruct-2507-q4_K_M`

- [ ] **Step 3: Set One Piece to gemma4**

Run: `pnpm tsx scripts/_set-campaign-model.ts 3ef630db gemma4:latest`
Expected: `✓ One Piece (3ef630db) aiMasterModel → gemma4:latest`

- [ ] **Step 4: Snapshot events.md line count BEFORE smoke**

Run: `wc -l ~/.dnd-ai-master/vault/campaigns/3ef630db-7b27-4000-a3c2-167abe7c6d3b/events.md`
Note the number (call it N).

- [ ] **Step 5: Operator runs 3 smoke turns**

In the browser (One Piece chat), send these 3 prompts one at a time, waiting for each response:
1. Narrative: *"Descrivi la taverna in cui Luffy si trova adesso, di notte."*
2. Combat (apply_event): *"Stendarr colpisce Luffy con il pugnale. Aggiorna lo stato: Luffy perde 4 HP."*
3. Combat (apply_event): *"Luffy reagisce e si concentra, recuperando lucidità. Aggiorna lo stato: Luffy guadagna ispirazione."*

- [ ] **Step 6: Inspect the result**

The assistant reads (from M5 Pro or via the funnel):
```bash
EV=~/.dnd-ai-master/vault/campaigns/3ef630db-7b27-4000-a3c2-167abe7c6d3b/events.md
wc -l "$EV"   # should be N + 2 (one hp_change + one inspiration_grant) if gemma4 drove apply_event
tail -3 "$EV"
```
Also grep the `pnpm dev` log (`.dev.log` if `pnpm dev:log`) for `[ollama]` lines (tok/s, wall) and `[vault-tool]`-equivalent dispatch evidence. Record: did gemma4 emit valid `apply_event` calls with UUID character? wall-clock? any infinite-loop / empty-response symptoms?

- [ ] **Step 7: Reset One Piece to qwen3**

Run: `pnpm tsx scripts/_set-campaign-model.ts 3ef630db qwen3:30b-a3b-instruct-2507-q4_K_M`
Expected: `✓ One Piece (3ef630db) aiMasterModel → qwen3:30b-a3b-instruct-2507-q4_K_M`

(If the gemma4 smoke wrote junk events you want gone, optionally `git`-less trim: the events are append-only; leave them or hand-trim the last 2 lines. Not critical for a test campaign.)

---

## Task 6: Final comparison table + recommendation + cleanup

**Files:**
- Delete: `scripts/_set-campaign-model.ts`
- Create: append results to `docs/superpowers/specs/2026-05-28-gemma4-model-comparison-design.md` (Results section) OR a new `.planning/` note — assistant's choice based on where it fits.

- [ ] **Step 1: Assemble the comparison table**

From Tasks 2-5 outputs, build:

| Axis | gemma4:latest | qwen3:30b-a3b-instruct-2507-q4_K_M | Winner |
|---|---|---|---|
| Narrative (avg chars / verdict) | … | … | … |
| Narrative wall-clock (avg) | … | … | … |
| Warm wall-clock (spike 004) | … | … | … |
| Tool-calling (apply_event valid UUID) | PASS/FAIL/unsupported | PASS (baseline) | … |
| Compliance (ok=N/5) | … | … | … |

- [ ] **Step 2: Write the recommendation**

One paragraph: promote gemma4 (to alternative or production — and if so, note the follow-up to surface it in `fetchOllamaModels`), or reject (with the deciding axis + reason).

- [ ] **Step 3: Delete the throwaway script + commit results**

```bash
rm scripts/_set-campaign-model.ts
git add docs/superpowers/specs/2026-05-28-gemma4-model-comparison-design.md
git commit -m "docs(spec): gemma4 comparison results + recommendation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Tasks 1 is the only pure-code task** (and it's tiny). It can run now, no hardware needed.
- **Tasks 2-5 are hardware-gated** on the Mac Mini being online + (for Task 5) `pnpm dev` running. If the Mac Mini is asleep, STOP and ask the operator to wake it; do not fabricate results.
- **Task 5 is gated on Task 2 PASS.** If gemma4 has no native tool calling, skip Task 5 entirely and mark the tool-calling axis "unsupported" in Task 6.
- **The operator runs the M4 harness commands** (Tasks 3, 4) and the browser smoke (Task 5 Step 5) — the assistant cannot drive the browser or run on the M4 directly; it sets up the DB state, reads results, and assembles the table.
- This is an experiment: no new tests, no production wiring. The throwaway script is deleted in Task 6.
