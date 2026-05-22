import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "../001-vault-harness-bootstrap/log";

const VAULT_ROOT = resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = "30m";
const MAX_TOOL_CALLS = 12;
const OUT_DIR = resolve(__dirname, "results");

const BAKED_MODEL = process.env.BAKED_MODEL ?? "dnd-master-plus:latest";
const VAULT_MODEL = process.env.VAULT_MODEL ?? "gpt-oss:20b";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaResponse {
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
}

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

- Static knowledge: \`/handbook/<category>/<id>.md\` (spells, monsters, rules)
- Active campaign: \`/campaigns/test/\` — entry point \`/campaigns/test/index.md\`
- Characters: \`/campaigns/test/characters/<name>.md\`

## Tool usage protocol

If you don't know what tools exist, your FIRST action is \`read_vault({"path": "/tools/index.md"})\`. After reading the index, you may invoke any listed tool directly without further documentation lookups.

Once you have gathered the information needed from the vault, respond by calling \`end_turn\` with your narrative answer (or you may end the turn by returning a final response without a tool call).

Keep responses concise and in-character as the DM.`;

const BAKED_SYSTEM_PROMPT = `You are an experienced D&D 5e Dungeon Master. The D&D 5e handbook, world lore, and SRD are part of your knowledge. Respond to the player's question directly with accurate rules information. Keep responses concise and in-character.`;

interface Scenario {
  id: string;
  query: string;
  expected_keywords: string[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "fireball-5th",
    query: "How much damage does a Fireball do when cast with a 5th-level spell slot?",
    expected_keywords: ["10d6"],
  },
  {
    id: "magic-missile-3rd",
    query: "How many darts does Magic Missile create when cast at 3rd level?",
    expected_keywords: ["5"],
  },
  {
    id: "aragorn-level",
    query: "What level is Aragorn?",
    expected_keywords: ["5"],
  },
  {
    id: "list-spells",
    query: "List every spell available in the handbook.",
    expected_keywords: ["Fireball", "Magic Missile", "Cure Wounds"],
  },
  {
    id: "cure-wounds-on-aragorn",
    query: "If I cast Cure Wounds on Aragorn with my +3 spellcasting modifier, what range of HP does he recover?",
    expected_keywords: ["1d8"],
  },
];

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
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.7, num_predict: 2500 },
  };
  if (tools) body.tools = tools;

  log.emit("ollama_request", { model, has_tools: !!tools, message_count: messages.length });
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as OllamaResponse;
  log.emit("ollama_response", {
    has_tool_calls: !!json.message?.tool_calls?.length,
    tool_call_count: json.message?.tool_calls?.length ?? 0,
    prompt_eval_count: json.prompt_eval_count,
    prompt_eval_duration_ms: json.prompt_eval_duration ? Math.round(json.prompt_eval_duration / 1e6) : 0,
    eval_count: json.eval_count,
    eval_duration_ms: json.eval_duration ? Math.round(json.eval_duration / 1e6) : 0,
    load_duration_ms: json.load_duration ? Math.round(json.load_duration / 1e6) : 0,
    total_duration_ms: json.total_duration ? Math.round(json.total_duration / 1e6) : 0,
  });
  return json;
}

interface TurnMetrics {
  setup: "baked" | "vault";
  model: string;
  scenario: string;
  start_state: "cold" | "warm";
  wall_clock_ms: number;
  prompt_eval_ms: number;
  eval_ms: number;
  load_ms: number;
  prompt_tokens: number;
  eval_tokens: number;
  tool_calls: number;
  response: string;
  correct: boolean;
}

async function runBaked(scenario: Scenario, startState: "cold" | "warm", log: ForensicLog): Promise<TurnMetrics> {
  if (startState === "cold") await unload(BAKED_MODEL);

  const messages: OllamaMessage[] = [
    { role: "system", content: BAKED_SYSTEM_PROMPT },
    { role: "user", content: scenario.query },
  ];

  const start = Date.now();
  const res = await chat(BAKED_MODEL, messages, null, log);
  const wall = Date.now() - start;
  const response = res.message?.content ?? "";
  const correct = scenario.expected_keywords.every((k) => response.toLowerCase().includes(k.toLowerCase()));

  return {
    setup: "baked",
    model: BAKED_MODEL,
    scenario: scenario.id,
    start_state: startState,
    wall_clock_ms: wall,
    prompt_eval_ms: res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0,
    eval_ms: res.eval_duration ? Math.round(res.eval_duration / 1e6) : 0,
    load_ms: res.load_duration ? Math.round(res.load_duration / 1e6) : 0,
    prompt_tokens: res.prompt_eval_count ?? 0,
    eval_tokens: res.eval_count ?? 0,
    tool_calls: 0,
    response: response.slice(0, 500),
    correct,
  };
}

async function runVault(scenario: Scenario, startState: "cold" | "warm", log: ForensicLog): Promise<TurnMetrics> {
  if (startState === "cold") await unload(VAULT_MODEL);

  const messages: OllamaMessage[] = [
    { role: "system", content: VAULT_SYSTEM_PROMPT },
    { role: "user", content: scenario.query },
  ];

  const start = Date.now();
  let toolCalls = 0;
  let prefillSum = 0;
  let evalSum = 0;
  let loadFirst = 0;
  let promptTokensSum = 0;
  let evalTokensSum = 0;
  let finalResponse = "";
  let firstCall = true;

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const res = await chat(VAULT_MODEL, messages, VAULT_TOOLS, log);

    prefillSum += res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0;
    evalSum += res.eval_duration ? Math.round(res.eval_duration / 1e6) : 0;
    promptTokensSum += res.prompt_eval_count ?? 0;
    evalTokensSum += res.eval_count ?? 0;
    if (firstCall) {
      loadFirst = res.load_duration ? Math.round(res.load_duration / 1e6) : 0;
      firstCall = false;
    }
    messages.push(res.message);

    const calls = res.message?.tool_calls ?? [];
    if (!calls.length) {
      finalResponse = res.message?.content ?? "";
      break;
    }

    let endHit = false;
    for (const call of calls) {
      toolCalls += 1;
      const name = call.function.name;
      const args = call.function.arguments ?? {};

      if (name === "end_turn") {
        finalResponse = (args.response as string) ?? "";
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
  const correct = scenario.expected_keywords.every((k) => finalResponse.toLowerCase().includes(k.toLowerCase()));

  return {
    setup: "vault",
    model: VAULT_MODEL,
    scenario: scenario.id,
    start_state: startState,
    wall_clock_ms: wall,
    prompt_eval_ms: prefillSum,
    eval_ms: evalSum,
    load_ms: loadFirst,
    prompt_tokens: promptTokensSum,
    eval_tokens: evalTokensSum,
    tool_calls: toolCalls,
    response: finalResponse.slice(0, 500),
    correct,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const logPath = join(OUT_DIR, `forensic-${Date.now()}.ndjson`);
  const log = new ForensicLog(logPath);

  const results: TurnMetrics[] = [];

  console.log(`▶ BAKED baseline: ${BAKED_MODEL}`);
  console.log(`▶ VAULT candidate: ${VAULT_MODEL}`);
  console.log(`▶ Scenarios: ${SCENARIOS.length}`);
  console.log(`▶ Per scenario: 1 cold + 1 warm per setup\n`);

  for (const scenario of SCENARIOS) {
    for (const setup of ["baked", "vault"] as const) {
      for (const state of ["cold", "warm"] as const) {
        process.stdout.write(`[${setup} ${state}] ${scenario.id}... `);
        log.emit("turn_start", { setup, scenario: scenario.id, state });
        const result = setup === "baked" ? await runBaked(scenario, state, log) : await runVault(scenario, state, log);
        results.push(result);
        const flag = result.correct ? "✓" : "✗";
        console.log(
          `${flag} wall=${result.wall_clock_ms}ms prefill=${result.prompt_eval_ms}ms eval=${result.eval_ms}ms load=${result.load_ms}ms calls=${result.tool_calls} ptok=${result.prompt_tokens} etok=${result.eval_tokens}`,
        );
      }
    }
  }

  writeFileSync(join(OUT_DIR, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));

  console.log("\n────────────────────────────────────────────────────");
  console.log(" WALL-CLOCK COMPARISON (avg across scenarios)");
  console.log("────────────────────────────────────────────────────");

  for (const state of ["cold", "warm"] as const) {
    const bakedSubset = results.filter((r) => r.setup === "baked" && r.start_state === state);
    const vaultSubset = results.filter((r) => r.setup === "vault" && r.start_state === state);
    const bakedAvgWall = Math.round(bakedSubset.reduce((s, r) => s + r.wall_clock_ms, 0) / bakedSubset.length);
    const vaultAvgWall = Math.round(vaultSubset.reduce((s, r) => s + r.wall_clock_ms, 0) / vaultSubset.length);
    const bakedAvgPrefill = Math.round(bakedSubset.reduce((s, r) => s + r.prompt_eval_ms, 0) / bakedSubset.length);
    const vaultAvgPrefill = Math.round(vaultSubset.reduce((s, r) => s + r.prompt_eval_ms, 0) / vaultSubset.length);
    const bakedAvgPromptTok = Math.round(bakedSubset.reduce((s, r) => s + r.prompt_tokens, 0) / bakedSubset.length);
    const vaultAvgPromptTok = Math.round(vaultSubset.reduce((s, r) => s + r.prompt_tokens, 0) / vaultSubset.length);
    const bakedCorrect = bakedSubset.filter((r) => r.correct).length;
    const vaultCorrect = vaultSubset.filter((r) => r.correct).length;
    const wallDelta = ((bakedAvgWall - vaultAvgWall) / bakedAvgWall) * 100;
    const prefillDelta = ((bakedAvgPrefill - vaultAvgPrefill) / bakedAvgPrefill) * 100;
    console.log(`${state.toUpperCase().padEnd(6)}  baked: wall=${bakedAvgWall}ms prefill=${bakedAvgPrefill}ms ptok=${bakedAvgPromptTok} ok=${bakedCorrect}/${bakedSubset.length}`);
    console.log(`        vault: wall=${vaultAvgWall}ms prefill=${vaultAvgPrefill}ms ptok=${vaultAvgPromptTok} ok=${vaultCorrect}/${vaultSubset.length}`);
    console.log(`        Δ wall: ${wallDelta >= 0 ? "-" : "+"}${Math.abs(wallDelta).toFixed(1)}% (vault ${wallDelta >= 0 ? "faster" : "slower"})`);
    console.log(`        Δ prefill: ${prefillDelta >= 0 ? "-" : "+"}${Math.abs(prefillDelta).toFixed(1)}%`);
  }
  console.log("────────────────────────────────────────────────────");
  console.log(`▶ Results JSON: ${OUT_DIR}/results-*.json`);
  console.log(`▶ Forensic log: ${logPath}`);
  console.log(`▶ G1 gate (M5 Pro reference only): wall-clock improvement ≥ 40%? ${results.length > 0 ? "see table above" : "no data"}`);
  console.log(`▶ G1 decision-grade measurement requires M4 hardware.`);
  console.log("────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
