import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "../001-vault-harness-bootstrap/log";

const VAULT_ROOT = resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = "30m";
const MAX_TOOL_CALLS = 16;
const OUT_DIR = resolve(__dirname, "results");
const MODEL = process.env.SPIKE_MODEL ?? "gpt-oss:20b";

const COMPLEX_QUERY =
  "I'm playing Aragorn (his sheet is in the campaign). I want to attack a Goblin (in the bestiary) with my longsword in melee. Tell me Aragorn's HP+AC, the Goblin's HP+AC, what to roll to hit, and whether Nimble Escape applies as a reaction. Be specific.";

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

const SEQUENTIAL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault",
      description: "Read ONE markdown file by vault path.",
      parameters: { type: "object" as const, properties: { path: { type: "string", description: "Absolute vault path" } }, required: ["path"] },
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

const BATCHED_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault_multi",
      description: "Read MULTIPLE markdown files in ONE call by giving an array of paths. Prefer this over multiple read_vault calls when you need several files.",
      parameters: {
        type: "object" as const,
        properties: { paths: { type: "array", description: "Array of absolute vault paths" } },
        required: ["paths"],
      },
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

const SYSTEM_BASE = `You are an experienced D&D 5e Dungeon Master.

Your vault root is '/vault'.
- Characters: /campaigns/test/characters/<name>.md
- Bestiary: /handbook/monsters/<id>.md
- Spells: /handbook/spells/<id>.md
- Campaign index: /campaigns/test/index.md

Keep responses concise.`;

const SYSTEM_SEQUENTIAL = `${SYSTEM_BASE}

You have two tools: read_vault (reads ONE file) and end_turn. Look up each file you need separately.`;

const SYSTEM_BATCHED = `${SYSTEM_BASE}

You have two tools: read_vault_multi (reads MANY files in ONE call) and end_turn. When you need multiple files (e.g. a character sheet and a monster stat block), call read_vault_multi ONCE with all paths at once.`;

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
  return paths
    .map((p) => `### ${p}\n\n${readOne(p)}`)
    .join("\n\n---\n\n");
}

async function unload(model: string) {
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

async function chat(messages: OllamaMessage[], tools: typeof SEQUENTIAL_TOOLS): Promise<OllamaResponse> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false, keep_alive: KEEP_ALIVE, options: { temperature: 0.5, num_predict: 1500 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()) as OllamaResponse;
}

interface Metrics {
  setup: "sequential" | "batched";
  state: "cold" | "warm";
  wall_ms: number;
  tool_calls: number;
  read_calls: number;
  paths_total: number;
  prompt_tokens: number;
  eval_tokens: number;
  prefill_ms: number;
  eval_ms: number;
  load_ms: number;
  response: string;
  keywords_found: number;
}

const EXPECTED_KEYWORDS = ["aragorn", "goblin", "15", "44", "nimble"];

async function runTurn(setup: "sequential" | "batched", state: "cold" | "warm", log: ForensicLog): Promise<Metrics> {
  if (state === "cold") await unload(MODEL);

  const system = setup === "sequential" ? SYSTEM_SEQUENTIAL : SYSTEM_BATCHED;
  const tools = setup === "sequential" ? SEQUENTIAL_TOOLS : BATCHED_TOOLS;
  const messages: OllamaMessage[] = [
    { role: "system", content: system },
    { role: "user", content: COMPLEX_QUERY },
  ];

  const start = Date.now();
  let toolCalls = 0;
  let readCalls = 0;
  let pathsTotal = 0;
  let prefillSum = 0;
  let evalSum = 0;
  let promptTokSum = 0;
  let evalTokSum = 0;
  let loadFirst = 0;
  let firstCall = true;
  let final = "";

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const res = await chat(messages, tools);
    prefillSum += res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0;
    evalSum += res.eval_duration ? Math.round(res.eval_duration / 1e6) : 0;
    promptTokSum += res.prompt_eval_count ?? 0;
    evalTokSum += res.eval_count ?? 0;
    if (firstCall) {
      loadFirst = res.load_duration ? Math.round(res.load_duration / 1e6) : 0;
      firstCall = false;
    }
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
      log.emit("tool_call", { setup, name, args });

      if (name === "end_turn") {
        final = (args.response as string) ?? "";
        endHit = true;
        break;
      }

      let result: string;
      if (name === "read_vault") {
        readCalls += 1;
        pathsTotal += 1;
        result = readOne((args.path as string) ?? "");
      } else if (name === "read_vault_multi") {
        readCalls += 1;
        const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
        pathsTotal += paths.length;
        result = readMany(paths);
      } else {
        result = `ERROR: unknown tool ${name}`;
      }
      messages.push({ role: "tool", content: result, tool_name: name });
    }
    if (endHit) break;
  }

  const wall = Date.now() - start;
  const lowered = final.toLowerCase();
  const kw = EXPECTED_KEYWORDS.filter((k) => lowered.includes(k.toLowerCase())).length;

  return {
    setup,
    state,
    wall_ms: wall,
    tool_calls: toolCalls,
    read_calls: readCalls,
    paths_total: pathsTotal,
    prompt_tokens: promptTokSum,
    eval_tokens: evalTokSum,
    prefill_ms: prefillSum,
    eval_ms: evalSum,
    load_ms: loadFirst,
    response: final.slice(0, 600),
    keywords_found: kw,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const log = new ForensicLog(join(OUT_DIR, `forensic-${Date.now()}.ndjson`));

  const results: Metrics[] = [];
  for (const setup of ["sequential", "batched"] as const) {
    for (const state of ["cold", "warm"] as const) {
      process.stdout.write(`[${setup} ${state}] ... `);
      const r = await runTurn(setup, state, log);
      results.push(r);
      console.log(`wall=${r.wall_ms}ms tool_calls=${r.tool_calls} read_calls=${r.read_calls} paths=${r.paths_total} ptok=${r.prompt_tokens} etok=${r.eval_tokens} kw=${r.keywords_found}/${EXPECTED_KEYWORDS.length}`);
    }
  }

  writeFileSync(join(OUT_DIR, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));

  console.log("\n────────────────────────────────────────────────────");
  console.log(" READ_VAULT vs READ_VAULT_MULTI");
  console.log("────────────────────────────────────────────────────");
  for (const r of results) {
    console.log(`${r.setup.padEnd(12)} ${r.state.padEnd(6)} wall=${r.wall_ms}ms tool_calls=${r.tool_calls} read_calls=${r.read_calls} paths=${r.paths_total} ptok=${r.prompt_tokens} kw=${r.keywords_found}/${EXPECTED_KEYWORDS.length}`);
  }

  const seqWarm = results.find((r) => r.setup === "sequential" && r.state === "warm");
  const batchWarm = results.find((r) => r.setup === "batched" && r.state === "warm");
  if (seqWarm && batchWarm) {
    const delta = ((seqWarm.wall_ms - batchWarm.wall_ms) / seqWarm.wall_ms) * 100;
    console.log(`\n▶ Δ wall (warm): ${delta >= 0 ? "-" : "+"}${Math.abs(delta).toFixed(1)}% (batched ${delta >= 0 ? "faster" : "slower"})`);
    console.log(`▶ Sequential: ${seqWarm.read_calls} read roundtrips for ${seqWarm.paths_total} paths`);
    console.log(`▶ Batched:    ${batchWarm.read_calls} read roundtrips for ${batchWarm.paths_total} paths`);
    console.log(`▶ Quality: sequential ${seqWarm.keywords_found}/${EXPECTED_KEYWORDS.length}, batched ${batchWarm.keywords_found}/${EXPECTED_KEYWORDS.length}`);
    console.log(`▶ G1-mitigation (≥50% wall improvement): ${delta >= 50 ? "✓ PASS" : "✗ FAIL"}`);
  }
  console.log("────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
