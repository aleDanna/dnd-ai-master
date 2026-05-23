import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "../001-vault-harness-bootstrap/log";

const VAULT_ROOT = resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.SPIKE_MODEL ?? "gpt-oss:20b";
const OUT_DIR = resolve(__dirname, "results");
const KEEP_ALIVE = "30m";
const TURNS_PER_MODE = parseInt(process.env.TURNS_PER_MODE ?? "5", 10);

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault",
      description: "Read a markdown file by absolute vault path.",
      parameters: { type: "object" as const, properties: { path: { type: "string", description: "Absolute path within vault" } }, required: ["path"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "end_turn",
      description: "Conclude turn and deliver final response.",
      parameters: { type: "object" as const, properties: { response: { type: "string", description: "Narrative response" } }, required: ["response"] },
    },
  },
];

const STABLE_SYSTEM = `You are an experienced D&D 5e Dungeon Master.

Your knowledge lives in a markdown vault at root '/vault'.
- Static knowledge: /handbook/<category>/<id>.md
- Active campaign: /campaigns/test/

If you don't know what tools exist, your FIRST action is to read /tools/index.md. After that, use any listed tool directly.

Keep responses concise.`;

const QUERIES = [
  "What level spell is Fireball?",
  "What level spell is Magic Missile?",
  "What level spell is Cure Wounds?",
  "What is the AC of a Goblin?",
  "How much HP does Aragorn have?",
];

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

function safeVaultPath(input: string): string | null {
  const stripped = input.replace(/^\/+/, "");
  const candidate = normalize(join(VAULT_ROOT, stripped));
  return candidate.startsWith(VAULT_ROOT) ? candidate : null;
}

function execReadVault(path: string): string {
  const abs = safeVaultPath(path);
  if (!abs) return "ERROR: path outside vault root";
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return `ERROR: file not found at ${path}`;
  }
}

async function chat(messages: OllamaMessage[]): Promise<OllamaResponse> {
  const body = { model: MODEL, messages, tools: TOOLS, stream: false, keep_alive: KEEP_ALIVE, options: { temperature: 0.3, num_predict: 800 } };
  const res = await fetch(`${OLLAMA_URL}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()) as OllamaResponse;
}

async function runTurn(systemPrompt: string, query: string): Promise<{ wall_ms: number; prefill_ms: number; prefill_tokens: number; load_ms: number }> {
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];
  const start = Date.now();
  let firstPrefillMs = 0;
  let firstPrefillTok = 0;
  let firstLoadMs = 0;
  let firstCall = true;

  for (let i = 0; i < 8; i++) {
    const res = await chat(messages);
    if (firstCall) {
      firstPrefillMs = res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0;
      firstPrefillTok = res.prompt_eval_count ?? 0;
      firstLoadMs = res.load_duration ? Math.round(res.load_duration / 1e6) : 0;
      firstCall = false;
    }
    messages.push(res.message);
    const calls = res.message?.tool_calls ?? [];
    if (!calls.length) break;
    let endHit = false;
    for (const call of calls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      if (name === "end_turn") {
        endHit = true;
        break;
      }
      if (name === "read_vault") {
        const result = execReadVault((args.path as string) ?? "");
        messages.push({ role: "tool", content: result, tool_name: name });
      } else {
        messages.push({ role: "tool", content: `ERROR: unknown tool ${name}`, tool_name: name });
      }
    }
    if (endHit) break;
  }
  return { wall_ms: Date.now() - start, prefill_ms: firstPrefillMs, prefill_tokens: firstPrefillTok, load_ms: firstLoadMs };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`▶ Model: ${MODEL}`);
  console.log(`▶ Turns per mode: ${TURNS_PER_MODE}`);
  console.log(`▶ Mode A (STABLE): same system prompt byte-for-byte across turns`);
  console.log(`▶ Mode B (DRIFT): system prompt with mutating timestamp prepended each turn`);
  console.log(`▶ Warm-up: 1 throwaway turn before each mode\n`);

  // Warm-up to load model
  console.log("Warming model...");
  await runTurn(STABLE_SYSTEM, "Warmup query");

  // Mode A — stable
  const stableResults: { wall_ms: number; prefill_ms: number; prefill_tokens: number; load_ms: number }[] = [];
  console.log("\n[STABLE mode]");
  for (let i = 0; i < TURNS_PER_MODE; i++) {
    const q = QUERIES[i % QUERIES.length];
    const r = await runTurn(STABLE_SYSTEM, q);
    stableResults.push(r);
    console.log(`  turn ${i + 1}: wall=${r.wall_ms}ms 1st-prefill=${r.prefill_ms}ms prefill-tokens=${r.prefill_tokens} load=${r.load_ms}ms`);
  }

  // Mode B — drift (prepend mutating timestamp)
  const driftResults: { wall_ms: number; prefill_ms: number; prefill_tokens: number; load_ms: number }[] = [];
  console.log("\n[DRIFT mode] (timestamp prepended each turn)");
  for (let i = 0; i < TURNS_PER_MODE; i++) {
    const q = QUERIES[i % QUERIES.length];
    const driftSystem = `[Turn timestamp: ${Date.now()}_${Math.random()}]\n${STABLE_SYSTEM}`;
    const r = await runTurn(driftSystem, q);
    driftResults.push(r);
    console.log(`  turn ${i + 1}: wall=${r.wall_ms}ms 1st-prefill=${r.prefill_ms}ms prefill-tokens=${r.prefill_tokens} load=${r.load_ms}ms`);
  }

  // Skip first turn of each mode (load_duration outlier) for averages
  const stableNoLoad = stableResults.slice(stableResults[0].load_ms > 1000 ? 1 : 0);
  const driftNoLoad = driftResults.slice(driftResults[0].load_ms > 1000 ? 1 : 0);
  const avg = (arr: number[]) => Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);

  const stableAvgWall = avg(stableNoLoad.map((r) => r.wall_ms));
  const driftAvgWall = avg(driftNoLoad.map((r) => r.wall_ms));
  const stableAvgPrefill = avg(stableNoLoad.map((r) => r.prefill_ms));
  const driftAvgPrefill = avg(driftNoLoad.map((r) => r.prefill_ms));

  const wallDelta = ((driftAvgWall - stableAvgWall) / stableAvgWall) * 100;
  const prefillDelta = ((driftAvgPrefill - stableAvgPrefill) / stableAvgPrefill) * 100;

  console.log("\n────────────────────────────────────────────────────");
  console.log(" CACHE STABILITY RESULT (excluding cold-load turn)");
  console.log("────────────────────────────────────────────────────");
  console.log(` STABLE avg wall: ${stableAvgWall}ms`);
  console.log(` DRIFT  avg wall: ${driftAvgWall}ms`);
  console.log(` Δ wall (drift penalty): +${wallDelta.toFixed(1)}%`);
  console.log(``);
  console.log(` STABLE avg 1st-prefill: ${stableAvgPrefill}ms`);
  console.log(` DRIFT  avg 1st-prefill: ${driftAvgPrefill}ms`);
  console.log(` Δ prefill (drift penalty): +${prefillDelta.toFixed(1)}%`);
  console.log("────────────────────────────────────────────────────");

  writeFileSync(join(OUT_DIR, `results-${Date.now()}.json`), JSON.stringify({ stable: stableResults, drift: driftResults }, null, 2));

  if (wallDelta > 20) {
    console.log(`▶ Drift penalty is SIGNIFICANT (+${wallDelta.toFixed(1)}%). Prefix-cache hygiene is MANDATORY in real build.`);
  } else if (wallDelta > 5) {
    console.log(`▶ Drift penalty is MODERATE (+${wallDelta.toFixed(1)}%). Worth enforcing, not catastrophic if violated.`);
  } else {
    console.log(`▶ Drift penalty is NEGLIGIBLE (+${wallDelta.toFixed(1)}%). Ollama's prefix-cache may be less effective than expected, OR the prompt is small enough that re-prefill is cheap.`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
