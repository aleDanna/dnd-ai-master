import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const TARGET_DIR = resolve(__dirname, "tmp");
const EVENTS_FILE = resolve(TARGET_DIR, "events.md");
const CHARACTER_FILE = resolve(TARGET_DIR, "aragorn.md");
const N = parseInt(process.env.EVENTS_N ?? "100", 10);

type Event =
  | { type: "hp_change"; delta: number }
  | { type: "condition_add"; condition: string }
  | { type: "condition_remove"; condition: string }
  | { type: "spell_slot_use"; level: number }
  | { type: "spell_slot_restore"; level: number };

interface CharacterState {
  hp_current: number;
  hp_max: number;
  conditions: string[];
  spell_slots: Record<number, { max: number; used: number }>;
}

const INITIAL: CharacterState = {
  hp_current: 44,
  hp_max: 44,
  conditions: [],
  spell_slots: {
    1: { max: 4, used: 0 },
    2: { max: 2, used: 0 },
  },
};

function randomEvent(): Event {
  const conds = ["poisoned", "frightened", "blinded", "prone", "stunned"];
  const r = Math.random();
  if (r < 0.4) return { type: "hp_change", delta: Math.floor(Math.random() * 21) - 10 };
  if (r < 0.55) return { type: "condition_add", condition: conds[Math.floor(Math.random() * conds.length)] };
  if (r < 0.7) return { type: "condition_remove", condition: conds[Math.floor(Math.random() * conds.length)] };
  if (r < 0.85) return { type: "spell_slot_use", level: 1 + Math.floor(Math.random() * 2) };
  return { type: "spell_slot_restore", level: 1 + Math.floor(Math.random() * 2) };
}

function applyEvent(state: CharacterState, event: Event): CharacterState {
  const next = structuredClone(state);
  switch (event.type) {
    case "hp_change":
      next.hp_current = Math.max(0, Math.min(state.hp_max, state.hp_current + event.delta));
      return next;
    case "condition_add":
      if (!next.conditions.includes(event.condition)) next.conditions.push(event.condition);
      return next;
    case "condition_remove":
      next.conditions = next.conditions.filter((c) => c !== event.condition);
      return next;
    case "spell_slot_use": {
      const slot = next.spell_slots[event.level];
      if (slot && slot.used < slot.max) slot.used += 1;
      return next;
    }
    case "spell_slot_restore": {
      const slot = next.spell_slots[event.level];
      if (slot && slot.used > 0) slot.used -= 1;
      return next;
    }
  }
}

function serializeEvent(e: Event): string {
  return JSON.stringify(e);
}

function deserializeEvent(line: string): Event {
  return JSON.parse(line) as Event;
}

function serializeCharacter(state: CharacterState): string {
  const slotLines = Object.entries(state.spell_slots)
    .map(([lvl, s]) => `  ${lvl}: { max: ${s.max}, used: ${s.used} }`)
    .join("\n");
  return `---
name: Aragorn
hp_current: ${state.hp_current}
hp_max: ${state.hp_max}
conditions: [${state.conditions.join(", ")}]
spell_slots:
${slotLines}
---

# Aragorn

Replayed character sheet from events.md.
`;
}

async function main() {
  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });

  // Generate N random events and compute expected state via in-memory simulation
  const events: Event[] = [];
  let expected = structuredClone(INITIAL);
  for (let i = 0; i < N; i++) {
    const e = randomEvent();
    events.push(e);
    expected = applyEvent(expected, e);
  }

  // Write events.md (append-only log)
  await writeFile(EVENTS_FILE, events.map(serializeEvent).join("\n") + "\n", "utf8");
  console.log(`▶ Generated ${N} events → ${EVENTS_FILE}`);

  // Replay from events.md
  const raw = await readFile(EVENTS_FILE, "utf8");
  const lines = raw.trim().split("\n");
  let replayed = structuredClone(INITIAL);
  for (const line of lines) {
    replayed = applyEvent(replayed, deserializeEvent(line));
  }

  // Write derived character file
  await writeFile(CHARACTER_FILE, serializeCharacter(replayed), "utf8");
  console.log(`▶ Replayed state → ${CHARACTER_FILE}`);

  // Compare
  const matches =
    expected.hp_current === replayed.hp_current &&
    expected.hp_max === replayed.hp_max &&
    expected.conditions.length === replayed.conditions.length &&
    expected.conditions.every((c) => replayed.conditions.includes(c)) &&
    JSON.stringify(expected.spell_slots) === JSON.stringify(replayed.spell_slots);

  console.log("\n────────────────────────────────────────────────────");
  console.log(" EVENT-SOURCED REPLAY RESULT");
  console.log("────────────────────────────────────────────────────");
  console.log(` Events: ${events.length}`);
  console.log(` Expected: hp=${expected.hp_current}/${expected.hp_max}, conditions=[${expected.conditions.join(",")}], slots=${JSON.stringify(expected.spell_slots)}`);
  console.log(` Replayed: hp=${replayed.hp_current}/${replayed.hp_max}, conditions=[${replayed.conditions.join(",")}], slots=${JSON.stringify(replayed.spell_slots)}`);
  console.log(` Match: ${matches ? "✓ YES" : "✗ NO"}`);
  console.log("────────────────────────────────────────────────────");

  // Resilience test: corrupt one line and ensure failure is detected
  console.log("\n▶ Resilience test: corrupt event line 50");
  const corruptedLines = [...lines];
  corruptedLines[50] = "{ this is not json";
  await writeFile(EVENTS_FILE, corruptedLines.join("\n") + "\n", "utf8");
  let corruptedFailed = false;
  let replayedCorrupt = structuredClone(INITIAL);
  try {
    for (const line of corruptedLines) {
      replayedCorrupt = applyEvent(replayedCorrupt, deserializeEvent(line));
    }
  } catch (e) {
    corruptedFailed = true;
    console.log(`  ✓ Corruption detected via JSON parse error (expected): ${String(e).slice(0, 100)}`);
  }
  if (!corruptedFailed) console.log(`  ✗ Corruption NOT detected — replay silently succeeded with bad data.`);

  process.exit(matches && corruptedFailed ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
