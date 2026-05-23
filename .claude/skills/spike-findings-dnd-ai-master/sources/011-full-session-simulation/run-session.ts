import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "../001-vault-harness-bootstrap/log";
import { buildSystemPrompt, hashPrompt } from "../012-prompt-builder-stability/builder";

const VAULT_ROOT = resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = "30m";
const MAX_TOOL_CALLS_PER_TURN = 12;
const OUT_DIR = resolve(__dirname, "results");
const MODEL = process.env.SPIKE_MODEL ?? "gpt-oss:20b";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaResponse {
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault_multi",
      description: "Read MANY markdown files in ONE call. Pass an array of vault paths. Prefer this when you need multiple files.",
      parameters: { type: "object" as const, properties: { paths: { type: "array", description: "Array of vault paths" } }, required: ["paths"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "end_turn",
      description: "Conclude turn with final response.",
      parameters: { type: "object" as const, properties: { response: { type: "string" } }, required: ["response"] },
    },
  },
];

const TURNS = [
  "What level spell is Fireball, and what's its base damage?",
  "I want to attack a Goblin with my longsword. Tell me its AC and HP.",
  "I rolled 17 to hit. Did I hit? If so, with my +5 attack and 1d8+3 damage roll of 7, how much HP does the goblin have left?",
  "Can the goblin use Nimble Escape as a reaction? Walk me through the timing.",
  "What's Aragorn's current HP and AC?",
  "I cast Cure Wounds on Aragorn — with my +3 spellcasting modifier, what range can he recover?",
  "Magic Missile at 3rd level — how many darts and total damage range?",
  "List all available spells in the handbook.",
  "If a fireball misses (Dex save succeeded), how much damage does the target still take?",
  "Aragorn finishes a long rest. What gets restored?",
];

const EXPECTED_KW = [
  ["3rd", "8d6"],
  ["goblin", "15", "7"],
  ["nimble"],
  ["nimble", "reaction"],
  ["aragorn", "44", "16"],
  ["1d8"],
  ["5", "1d4"],
  ["fireball", "magic", "cure"],
  ["half"],
  ["spell", "hit", "long rest"],
];

function safeVaultPath(input: string): string | null {
  const stripped = input.replace(/^\/+/, "");
  const candidate = normalize(join(VAULT_ROOT, stripped));
  return candidate.startsWith(VAULT_ROOT) ? candidate : null;
}

function readOne(path: string): string {
  const abs = safeVaultPath(path);
  if (!abs) return "ERROR: path outside vault";
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return `ERROR: file not found at ${path}`;
  }
}

function readMany(paths: string[]): string {
  return paths.map((p) => `### ${p}\n\n${readOne(p)}`).join("\n\n---\n\n");
}

async function chat(messages: OllamaMessage[]): Promise<OllamaResponse> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false, keep_alive: KEEP_ALIVE, options: { temperature: 0.5, num_predict: 1200 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()) as OllamaResponse;
}

interface TurnResult {
  turn: number;
  query: string;
  wall_ms: number;
  tool_calls: number;
  prompt_tokens: number;
  eval_tokens: number;
  prefill_ms: number;
  eval_ms: number;
  response_chars: number;
  response_preview: string;
  keywords_found: number;
  keywords_total: number;
  system_hash: string;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const log = new ForensicLog(join(OUT_DIR, `forensic-${Date.now()}.ndjson`));

  const SYSTEM = buildSystemPrompt({ vaultRoot: "/vault", campaignId: "test", toolCount: TOOLS.length });
  const SYSTEM_HASH = hashPrompt(SYSTEM);
  console.log(`▶ Model: ${MODEL}`);
  console.log(`▶ System prompt SHA256: ${SYSTEM_HASH.slice(0, 16)}…`);
  console.log(`▶ Running ${TURNS.length} consecutive turns (warm session, shared message history)\n`);

  const messages: OllamaMessage[] = [{ role: "system", content: SYSTEM }];
  const results: TurnResult[] = [];

  for (let t = 0; t < TURNS.length; t++) {
    const query = TURNS[t];
    const expected = EXPECTED_KW[t];
    messages.push({ role: "user", content: query });
    log.emit("turn_start", { turn: t + 1, query });
    const start = Date.now();
    let toolCalls = 0;
    let prefillSum = 0;
    let evalSum = 0;
    let promptTokSum = 0;
    let evalTokSum = 0;
    let final = "";

    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
      const res = await chat(messages);
      prefillSum += res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0;
      evalSum += res.eval_duration ? Math.round(res.eval_duration / 1e6) : 0;
      promptTokSum += res.prompt_eval_count ?? 0;
      evalTokSum += res.eval_count ?? 0;
      messages.push(res.message);

      const calls = res.message?.tool_calls ?? [];
      if (!calls.length) {
        final = res.message?.content ?? "";
        break;
      }
      let endHit = false;
      for (const call of calls) {
        toolCalls += 1;
        const name = call.function.name;
        const args = call.function.arguments ?? {};
        if (name === "end_turn") {
          final = (args.response as string) ?? "";
          endHit = true;
          break;
        }
        if (name === "read_vault_multi") {
          const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
          messages.push({ role: "tool", content: readMany(paths), tool_name: name });
        } else {
          messages.push({ role: "tool", content: `ERROR: unknown tool ${name}`, tool_name: name });
        }
      }
      if (endHit) break;
    }

    const wall = Date.now() - start;
    const lowered = final.toLowerCase();
    const kw = expected.filter((k) => lowered.includes(k.toLowerCase())).length;

    // Re-hash the system message in the live transcript — it MUST still match
    const liveSystemHash = hashPrompt(messages[0].content);
    const r: TurnResult = {
      turn: t + 1,
      query,
      wall_ms: wall,
      tool_calls: toolCalls,
      prompt_tokens: promptTokSum,
      eval_tokens: evalTokSum,
      prefill_ms: prefillSum,
      eval_ms: evalSum,
      response_chars: final.length,
      response_preview: final.slice(0, 200),
      keywords_found: kw,
      keywords_total: expected.length,
      system_hash: liveSystemHash,
    };
    results.push(r);
    console.log(
      `[turn ${(t + 1).toString().padStart(2)}] wall=${r.wall_ms.toString().padStart(6)}ms tool_calls=${r.tool_calls} prefill=${r.prefill_ms}ms eval=${r.eval_ms}ms ptok=${r.prompt_tokens} etok=${r.eval_tokens} kw=${kw}/${expected.length}${liveSystemHash === SYSTEM_HASH ? "" : " ⚠ HASH DRIFT"}`,
    );
  }

  writeFileSync(join(OUT_DIR, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));

  const totalWall = results.reduce((s, r) => s + r.wall_ms, 0);
  const avgWall = Math.round(totalWall / results.length);
  const totalKw = results.reduce((s, r) => s + r.keywords_found, 0);
  const totalKwExpected = results.reduce((s, r) => s + r.keywords_total, 0);
  const qualityPct = (totalKw / totalKwExpected) * 100;
  const allKwHits = results.filter((r) => r.keywords_found === r.keywords_total).length;
  const allHashesStable = results.every((r) => r.system_hash === SYSTEM_HASH);
  const m4Estimate = Math.round(avgWall * 2.5);
  const turnsUnder30s = results.filter((r) => r.wall_ms < 30000).length;

  console.log("\n────────────────────────────────────────────────────");
  console.log(" SESSION SUMMARY");
  console.log("────────────────────────────────────────────────────");
  console.log(` Total wall-clock: ${(totalWall / 1000).toFixed(1)}s across ${TURNS.length} turns`);
  console.log(` Avg wall per turn (M5 Pro): ${avgWall}ms`);
  console.log(` Estimated avg wall per turn (M4 ×2.5): ${m4Estimate}ms`);
  console.log(` Turns under 30s M5 Pro: ${turnsUnder30s}/${TURNS.length}`);
  console.log(` Quality: ${totalKw}/${totalKwExpected} keywords (${qualityPct.toFixed(1)}%)`);
  console.log(` Turns with all keywords hit: ${allKwHits}/${TURNS.length}`);
  console.log(` Prefix cache stability (system_hash unchanged): ${allHashesStable ? "✓ YES" : "✗ NO"}`);
  console.log("────────────────────────────────────────────────────");

  const gateAvgWall = avgWall < 25000;
  const gateQuality = qualityPct >= 80;
  const gateStable = allHashesStable;
  console.log(` G1 mitigation gate (avg < 25s on M5 Pro): ${gateAvgWall ? "✓ PASS" : "✗ FAIL"}`);
  console.log(` Quality gate (≥80% keywords): ${gateQuality ? "✓ PASS" : "✗ FAIL"}`);
  console.log(` Prefix stability gate: ${gateStable ? "✓ PASS" : "✗ FAIL"}`);
  console.log("────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
