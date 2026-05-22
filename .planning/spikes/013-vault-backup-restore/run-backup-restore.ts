import { readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(__dirname, "tmp");
const VAULT = join(ROOT, "vault");
const BACKUP = join(ROOT, "backup");

type Event = { id: number; type: "hp_change" | "condition_add"; payload: Record<string, unknown> };

const EVENTS: Event[] = [
  { id: 0, type: "hp_change", payload: { delta: -10 } },
  { id: 1, type: "hp_change", payload: { delta: -5 } },
  { id: 2, type: "condition_add", payload: { condition: "poisoned" } },
  { id: 3, type: "hp_change", payload: { delta: 8 } },
  { id: 4, type: "condition_add", payload: { condition: "frightened" } },
];

interface State {
  hp_current: number;
  hp_max: number;
  conditions: string[];
}

const INITIAL: State = { hp_current: 44, hp_max: 44, conditions: [] };

function applyEvent(state: State, e: Event): State {
  const next = structuredClone(state);
  if (e.type === "hp_change") {
    next.hp_current = Math.max(0, Math.min(state.hp_max, state.hp_current + (e.payload.delta as number)));
  } else if (e.type === "condition_add") {
    const c = e.payload.condition as string;
    if (!next.conditions.includes(c)) next.conditions.push(c);
  }
  return next;
}

function serializeView(state: State): string {
  return `---
name: Aragorn
hp_current: ${state.hp_current}
hp_max: ${state.hp_max}
conditions: [${state.conditions.join(", ")}]
---

# Aragorn

Materialized from events.md.
`;
}

function projectAll(events: Event[]): State {
  let state = structuredClone(INITIAL);
  for (const e of events) state = applyEvent(state, e);
  return state;
}

async function setup() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(VAULT, { recursive: true });
  await mkdir(join(VAULT, "characters"), { recursive: true });

  // Write events.md (source of truth)
  await writeFile(join(VAULT, "events.md"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  // Materialize derived view from events
  const state = projectAll(EVENTS);
  await writeFile(join(VAULT, "characters", "aragorn.md"), serializeView(state), "utf8");
}

async function backup() {
  // Use cp -r as a stand-in for "git commit" or "tar". Same effect: snapshot the vault.
  await rm(BACKUP, { recursive: true, force: true });
  await cp(VAULT, BACKUP, { recursive: true });
}

async function corrupt() {
  // Simulate a torn write / partial mutation: overwrite the derived view with garbage.
  await writeFile(join(VAULT, "characters", "aragorn.md"), "CORRUPTED RANDOM BYTES\n\n---broken---\n", "utf8");
}

async function restore() {
  // Restore strategy:
  // 1. Restore events.md from backup (it's the source of truth)
  // 2. Replay events.md to regenerate all derived views
  await cp(join(BACKUP, "events.md"), join(VAULT, "events.md"));
  const raw = await readFile(join(VAULT, "events.md"), "utf8");
  const events: Event[] = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const state = projectAll(events);
  await writeFile(join(VAULT, "characters", "aragorn.md"), serializeView(state), "utf8");
}

async function compareToBackup(): Promise<{ identical: boolean; details: string }> {
  const orig = await readFile(join(BACKUP, "characters", "aragorn.md"), "utf8");
  const restored = await readFile(join(VAULT, "characters", "aragorn.md"), "utf8");
  if (orig === restored) return { identical: true, details: "byte-for-byte match" };
  return { identical: false, details: `expected:\n${orig}\n---\ngot:\n${restored}` };
}

async function main() {
  console.log("▶ Step 1: build vault with 5 events + derived view");
  await setup();
  const sha1 = execSync(`shasum ${join(VAULT, "characters", "aragorn.md")}`).toString().trim();
  console.log(`  Initial view: ${sha1}`);

  console.log("▶ Step 2: backup vault (simulating 'git commit')");
  await backup();

  console.log("▶ Step 3: corrupt the derived view");
  await corrupt();
  const corruptSha = execSync(`shasum ${join(VAULT, "characters", "aragorn.md")}`).toString().trim();
  console.log(`  Corrupted view: ${corruptSha}`);

  console.log("▶ Step 4: restore via events.md replay");
  await restore();
  const restoredSha = execSync(`shasum ${join(VAULT, "characters", "aragorn.md")}`).toString().trim();
  console.log(`  Restored view: ${restoredSha}`);

  console.log("▶ Step 5: compare restored to original backup");
  const cmp = await compareToBackup();
  console.log(`\n────────────────────────────────────────────────────`);
  console.log(` BACKUP/RESTORE RESULT`);
  console.log(`────────────────────────────────────────────────────`);
  console.log(` Restored == backup: ${cmp.identical ? "✓ YES" : "✗ NO"}`);
  console.log(` Detail: ${cmp.details}`);
  console.log(`────────────────────────────────────────────────────`);

  if (cmp.identical) {
    console.log(`✓ DR procedure works: events.md is sufficient source of truth.`);
    console.log(`  git repo of vault + events.md = full disaster recovery.`);
    process.exit(0);
  } else {
    console.log(`✗ Restore did not match. The replay projector is non-deterministic OR events.md is incomplete.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
