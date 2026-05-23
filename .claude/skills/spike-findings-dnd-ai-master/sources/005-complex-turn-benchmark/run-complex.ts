import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "../001-vault-harness-bootstrap/log";

const VAULT_ROOT = resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = "30m";
const MAX_TOOL_CALLS = 16;
const OUT_DIR = resolve(__dirname, "results");

const BAKED_MODEL = process.env.BAKED_MODEL ?? "dnd-master-plus:latest";
const VAULT_MODEL = process.env.VAULT_MODEL ?? "gpt-oss:20b";

const COMPLEX_SCENARIO = {
  id: "combat-round",
  query:
    "I'm playing Aragorn (you can find his sheet in the campaign). I want to attack a Goblin (find its stats in the bestiary) using my longsword in melee. Walk me through one full round of combat: tell me Aragorn's HP and AC, the Goblin's HP and AC, what attack roll I need to beat to hit, and what happens if my attack hits dealing 1d8+3 damage. Also tell me whether the Goblin can use Nimble Escape as a reaction this turn.",
  expected_keywords: ["aragorn", "goblin", "15", "ac", "nimble"],
  expected_tool_min: 2,
};

const VAULT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault",
      description: "Read a markdown file by absolute vault path.",
      parameters: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Absolute path within vault" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_vault",
      description: "List children of a vault directory.",
      parameters: {
        type: "object" as const,
        properties: { directory: { type: "string", description: "Directory path within vault" } },
        required: ["directory"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "end_turn",
      description: "Conclude turn and deliver final response.",
      parameters: {
        type: "object" as const,
        properties: { response: { type: "string", description: "Narrative response to player" } },
        required: ["response"],
      },
    },
  },
];

const VAULT_SYSTEM_PROMPT = `You are an experienced D&D 5e Dungeon Master.

## Knowledge layout

Your knowledge lives in a markdown vault at root '/vault'.
- Static knowledge: \`/handbook/<category>/<id>.md\` (spells, monsters, items, rules)
- Active campaign: \`/campaigns/test/\` — entry point \`/campaigns/test/index.md\`
- Characters: \`/campaigns/test/characters/<name>.md\`
- Bestiary: \`/handbook/monsters/<id>.md\`

## Tool usage protocol

If you don't know what tools exist, your FIRST action is \`read_vault({"path": "/tools/index.md"})\`. After reading the index, use any listed tool directly.

When the player's question requires multiple facts, look them all up before responding. Be thorough — do not guess values you can read from the vault.

Once you have gathered the information needed, respond by calling \`end_turn\` with your narrative answer.`;

const BAKED_SYSTEM_PROMPT = `You are an experienced D&D 5e Dungeon Master. The D&D 5e handbook and SRD are part of your knowledge. The player has a character named Aragorn (Human Ranger, level 5, HP 44, AC 16, longsword). Goblins are CR 1/4 with HP 7, AC 15, Nimble Escape trait. Respond to the player's question with accurate rules information.`;

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

function execListVault(directory: string): string {
  const abs = safeVaultPath(directory);
  if (!abs) return "ERROR: path outside vault root";
  try {
    return readdirSync(abs)
      .map((e) => (statSync(join(abs, e)).isDirectory() ? `${e}/` : e))
      .join("\n");
  } catch {
    return `ERROR: directory not found at ${directory}`;
  }
}

async function unload(model: string): Promise<void> {
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

async function chat(model: string, messages: OllamaMessage[], tools: typeof VAULT_TOOLS | null, log: ForensicLog): Promise<OllamaResponse> {
  const body: Record<string, unknown> = { model, messages, stream: false, keep_alive: KEEP_ALIVE, options: { temperature: 0.7, num_predict: 2500 } };
  if (tools) body.tools = tools;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as OllamaResponse;
  log.emit("ollama_response", {
    has_tool_calls: !!json.message?.tool_calls?.length,
    prompt_eval_count: json.prompt_eval_count,
    prompt_eval_duration_ms: json.prompt_eval_duration ? Math.round(json.prompt_eval_duration / 1e6) : 0,
    eval_count: json.eval_count,
    eval_duration_ms: json.eval_duration ? Math.round(json.eval_duration / 1e6) : 0,
    load_duration_ms: json.load_duration ? Math.round(json.load_duration / 1e6) : 0,
    total_duration_ms: json.total_duration ? Math.round(json.total_duration / 1e6) : 0,
  });
  return json;
}

interface Metrics {
  setup: "baked" | "vault";
  state: "cold" | "warm";
  wall_ms: number;
  tool_calls: number;
  prompt_tokens: number;
  eval_tokens: number;
  prefill_ms: number;
  eval_ms: number;
  response: string;
  keywords_found: number;
  keywords_total: number;
  tool_call_min_met: boolean;
}

async function runBaked(state: "cold" | "warm", log: ForensicLog): Promise<Metrics> {
  if (state === "cold") await unload(BAKED_MODEL);
  const start = Date.now();
  const res = await chat(BAKED_MODEL, [
    { role: "system", content: BAKED_SYSTEM_PROMPT },
    { role: "user", content: COMPLEX_SCENARIO.query },
  ], null, log);
  const wall = Date.now() - start;
  const response = res.message?.content ?? "";
  const lowered = response.toLowerCase();
  const found = COMPLEX_SCENARIO.expected_keywords.filter((k) => lowered.includes(k.toLowerCase())).length;
  return {
    setup: "baked",
    state,
    wall_ms: wall,
    tool_calls: 0,
    prompt_tokens: res.prompt_eval_count ?? 0,
    eval_tokens: res.eval_count ?? 0,
    prefill_ms: res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0,
    eval_ms: res.eval_duration ? Math.round(res.eval_duration / 1e6) : 0,
    response: response.slice(0, 800),
    keywords_found: found,
    keywords_total: COMPLEX_SCENARIO.expected_keywords.length,
    tool_call_min_met: true,
  };
}

async function runVault(state: "cold" | "warm", log: ForensicLog): Promise<Metrics> {
  if (state === "cold") await unload(VAULT_MODEL);
  const messages: OllamaMessage[] = [
    { role: "system", content: VAULT_SYSTEM_PROMPT },
    { role: "user", content: COMPLEX_SCENARIO.query },
  ];
  const start = Date.now();
  let toolCalls = 0;
  let prefillSum = 0;
  let evalSum = 0;
  let promptTokSum = 0;
  let evalTokSum = 0;
  let final = "";

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const res = await chat(VAULT_MODEL, messages, VAULT_TOOLS, log);
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
      let result: string;
      if (name === "read_vault") result = execReadVault((args.path as string) ?? "");
      else if (name === "list_vault") result = execListVault((args.directory as string) ?? "");
      else result = `ERROR: unknown tool ${name}`;
      messages.push({ role: "tool", content: result, tool_name: name });
    }
    if (endHit) break;
  }

  const wall = Date.now() - start;
  const lowered = final.toLowerCase();
  const found = COMPLEX_SCENARIO.expected_keywords.filter((k) => lowered.includes(k.toLowerCase())).length;
  return {
    setup: "vault",
    state,
    wall_ms: wall,
    tool_calls: toolCalls,
    prompt_tokens: promptTokSum,
    eval_tokens: evalTokSum,
    prefill_ms: prefillSum,
    eval_ms: evalSum,
    response: final.slice(0, 800),
    keywords_found: found,
    keywords_total: COMPLEX_SCENARIO.expected_keywords.length,
    tool_call_min_met: toolCalls >= COMPLEX_SCENARIO.expected_tool_min,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const log = new ForensicLog(join(OUT_DIR, `forensic-${Date.now()}.ndjson`));
  log.emit("turn_start", { scenario: COMPLEX_SCENARIO.id });

  const results: Metrics[] = [];

  for (const setup of ["baked", "vault"] as const) {
    for (const state of ["cold", "warm"] as const) {
      process.stdout.write(`[${setup} ${state}] ... `);
      const r = setup === "baked" ? await runBaked(state, log) : await runVault(state, log);
      results.push(r);
      console.log(`wall=${r.wall_ms}ms calls=${r.tool_calls} ptok=${r.prompt_tokens} etok=${r.eval_tokens} keywords=${r.keywords_found}/${r.keywords_total}`);
    }
  }

  writeFileSync(join(OUT_DIR, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));

  console.log("\n────────────────────────────────────────────────────");
  console.log(" COMPLEX TURN — wall-clock and quality");
  console.log("────────────────────────────────────────────────────");
  for (const r of results) {
    console.log(`${r.setup.padEnd(6)} ${r.state.padEnd(6)} wall=${r.wall_ms}ms calls=${r.tool_calls} prefill=${r.prefill_ms}ms eval=${r.eval_ms}ms ptok=${r.prompt_tokens} etok=${r.eval_tokens} kw=${r.keywords_found}/${r.keywords_total}`);
  }
  console.log("────────────────────────────────────────────────────");

  const vaultWarm = results.find((r) => r.setup === "vault" && r.state === "warm");
  const bakedWarm = results.find((r) => r.setup === "baked" && r.state === "warm");
  if (vaultWarm && bakedWarm) {
    const delta = ((bakedWarm.wall_ms - vaultWarm.wall_ms) / bakedWarm.wall_ms) * 100;
    console.log(`\n▶ Δ wall (warm): ${delta >= 0 ? "-" : "+"}${Math.abs(delta).toFixed(1)}% (vault ${delta >= 0 ? "faster" : "slower"})`);
    console.log(`▶ Vault tool calls used (warm): ${vaultWarm.tool_calls} (gate: ≥${COMPLEX_SCENARIO.expected_tool_min})`);
    console.log(`▶ Quality vault: ${vaultWarm.keywords_found}/${vaultWarm.keywords_total}, baked: ${bakedWarm.keywords_found}/${bakedWarm.keywords_total}`);
    console.log(`▶ G1 retention threshold: warm wall < 30s on M5 Pro = ${vaultWarm.wall_ms < 30000 ? "✓ PASS" : "✗ FAIL"} (target was M4 < 30s; M5 proxy is harder)`);
  }
  console.log("────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
