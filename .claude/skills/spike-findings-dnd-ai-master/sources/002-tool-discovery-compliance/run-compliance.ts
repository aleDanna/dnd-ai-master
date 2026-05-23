import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "../001-vault-harness-bootstrap/log";
import { buildCompliancePrompt, SCENARIOS, type PromptStrength } from "./prompts";

const VAULT_ROOT = resolve(__dirname, "..", "001-vault-harness-bootstrap", "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = "30m";
const MAX_TOOL_CALLS = 12;
const OUT_DIR = resolve(__dirname, "results");

const MODELS_TO_TEST = (process.env.SPIKE_MODELS ?? "llama3.2:3b,gpt-oss:20b,qwen3:30b-a3b").split(",");
const STRENGTHS: PromptStrength[] = (process.env.SPIKE_STRENGTHS ?? "V2_strict").split(",") as PromptStrength[];
const REPETITIONS = parseInt(process.env.SPIKE_REPETITIONS ?? "2", 10);

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaChatResponse {
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

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_vault",
      description: "Read a markdown file by absolute vault path.",
      parameters: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Absolute path within vault, e.g. '/handbook/spells/fireball.md'" },
        },
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
        properties: {
          directory: { type: "string", description: "Directory path within vault, e.g. '/handbook/spells'" },
        },
        required: ["directory"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "end_turn",
      description: "Conclude turn and deliver final response to player.",
      parameters: {
        type: "object" as const,
        properties: {
          response: { type: "string", description: "Narrative response to player. Markdown allowed." },
        },
        required: ["response"],
      },
    },
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

async function ollamaChat(model: string, messages: OllamaMessage[], log: ForensicLog): Promise<OllamaChatResponse> {
  const body = {
    model,
    messages,
    tools: TOOLS,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.7, num_predict: 2500 },
  };
  log.emit("ollama_request", { model, message_count: messages.length });
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama ${res.status}: ${text}`);
  }
  const json = (await res.json()) as OllamaChatResponse;
  log.emit("ollama_response", {
    done: json.done,
    done_reason: json.done_reason,
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

interface CallTrace {
  name: string;
  args: Record<string, unknown>;
  index: number;
}

interface TurnResult {
  scenario: string;
  model: string;
  strength: PromptStrength;
  repetition: number;
  trace: CallTrace[];
  finished: "end_turn_tool" | "no_tool_calls" | "max_exceeded" | "error";
  wall_clock_ms: number;
  prompt_tokens_total: number;
  eval_tokens_total: number;
  prompt_eval_ms_total: number;
  eval_ms_total: number;
  load_duration_ms_first: number;
  compliance_strict: ComplianceVerdict;
  compliance_lenient: ComplianceVerdict;
}

interface ComplianceVerdict {
  passed: boolean;
  details: { tool: string; pre_read: boolean }[];
}

function classifyCompliance(trace: CallTrace[]): { strict: ComplianceVerdict; lenient: ComplianceVerdict } {
  const distinctToolsByFirstUse: { tool: string; index: number }[] = [];
  for (let i = 0; i < trace.length; i++) {
    const t = trace[i].name;
    if (!distinctToolsByFirstUse.some((x) => x.tool === t)) {
      distinctToolsByFirstUse.push({ tool: t, index: i });
    }
  }

  const wasIndexRead = trace.some(
    (c) => c.name === "read_vault" && (c.args.path as string) === "/tools/index.md",
  );

  const strictDetails = distinctToolsByFirstUse.map(({ tool, index }) => {
    if (tool === "read_vault") {
      // For read_vault itself, compliance means /tools/read_vault.md was read BEFORE
      // any non-/tools/* read_vault call, AND /tools/index.md may also be required upfront.
      // Simplest interpretation: the first read_vault must target /tools/index.md or /tools/read_vault.md.
      const firstReadArg = (trace[index].args.path as string) ?? "";
      return { tool, pre_read: firstReadArg.startsWith("/tools/") };
    }
    const preRead = trace
      .slice(0, index)
      .some((c) => c.name === "read_vault" && (c.args.path as string) === `/tools/${tool}.md`);
    return { tool, pre_read: preRead };
  });

  const lenientDetails = distinctToolsByFirstUse.map(({ tool, index }) => {
    if (tool === "read_vault") {
      const firstReadArg = (trace[index].args.path as string) ?? "";
      return { tool, pre_read: firstReadArg.startsWith("/tools/") };
    }
    const preRead = trace
      .slice(0, index)
      .some(
        (c) =>
          c.name === "read_vault" &&
          ((c.args.path as string) === `/tools/${tool}.md` ||
            ((c.args.path as string) === "/tools/index.md" && wasIndexRead)),
      );
    return { tool, pre_read: preRead };
  });

  return {
    strict: { passed: strictDetails.every((d) => d.pre_read), details: strictDetails },
    lenient: { passed: lenientDetails.every((d) => d.pre_read), details: lenientDetails },
  };
}

async function runOneTurn(
  model: string,
  strength: PromptStrength,
  scenario: { id: string; query: string },
  repetition: number,
): Promise<TurnResult> {
  const logPath = join(OUT_DIR, `forensic-${model.replace(/[:/]/g, "_")}-${strength}-${scenario.id}-r${repetition}-${Date.now()}.ndjson`);
  const log = new ForensicLog(logPath);
  log.emit("turn_start", { model, strength, scenario: scenario.id, repetition, query: scenario.query });

  const messages: OllamaMessage[] = [
    { role: "system", content: buildCompliancePrompt({ vaultRoot: "/vault", campaignId: "test", strength }) },
    { role: "user", content: scenario.query },
  ];

  const trace: CallTrace[] = [];
  let finished: TurnResult["finished"] = "max_exceeded";
  const startedAt = Date.now();

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    let res: OllamaChatResponse;
    try {
      res = await ollamaChat(model, messages, log);
    } catch (e) {
      log.emit("error", { reason: String(e) });
      finished = "error";
      break;
    }
    messages.push(res.message);

    const calls = res.message?.tool_calls ?? [];
    if (!calls.length) {
      log.emit("end_turn", { reason: "no_tool_calls", content_preview: (res.message?.content ?? "").slice(0, 200) });
      finished = "no_tool_calls";
      break;
    }

    let endTurnHit = false;
    for (const call of calls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      trace.push({ name, args, index: trace.length });
      log.emit("tool_call", { name, args });

      if (name === "end_turn") {
        endTurnHit = true;
        log.emit("end_turn", { reason: "end_turn_tool", response_preview: ((args.response as string) ?? "").slice(0, 200) });
        break;
      }

      let result: string;
      if (name === "read_vault") result = execReadVault((args.path as string) ?? "");
      else if (name === "list_vault") result = execListVault((args.directory as string) ?? "");
      else result = `ERROR: unknown tool ${name}`;

      log.emit("tool_result", { name, ok: !result.startsWith("ERROR"), bytes: result.length });
      messages.push({ role: "tool", content: result, tool_name: name });
    }

    if (endTurnHit) {
      finished = "end_turn_tool";
      break;
    }
  }

  const wallClock = Date.now() - startedAt;
  const summary = log.summary();
  const compliance = classifyCompliance(trace);
  log.emit("summary", { ...summary, trace_length: trace.length, compliance_strict: compliance.strict.passed, compliance_lenient: compliance.lenient.passed });

  return {
    scenario: scenario.id,
    model,
    strength,
    repetition,
    trace,
    finished,
    wall_clock_ms: wallClock,
    prompt_tokens_total: summary.total_prompt_tokens,
    eval_tokens_total: summary.total_eval_tokens,
    prompt_eval_ms_total: summary.total_prompt_eval_ms,
    eval_ms_total: summary.total_eval_ms,
    load_duration_ms_first: 0,
    compliance_strict: compliance.strict,
    compliance_lenient: compliance.lenient,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const results: TurnResult[] = [];
  let turnCount = 0;
  const totalTurns = MODELS_TO_TEST.length * STRENGTHS.length * SCENARIOS.length * REPETITIONS;
  console.log(`▶ Running ${totalTurns} turns (${MODELS_TO_TEST.length} models × ${STRENGTHS.length} strengths × ${SCENARIOS.length} scenarios × ${REPETITIONS} reps)\n`);

  for (const model of MODELS_TO_TEST) {
    for (const strength of STRENGTHS) {
      for (const scenario of SCENARIOS) {
        for (let r = 0; r < REPETITIONS; r++) {
          turnCount += 1;
          process.stdout.write(`[${turnCount}/${totalTurns}] ${model} ${strength} ${scenario.id} r${r}... `);
          const result = await runOneTurn(model, strength, scenario, r);
          results.push(result);
          const flag = result.compliance_strict.passed ? "✓" : result.compliance_lenient.passed ? "~" : "✗";
          console.log(
            `${flag} ${result.finished} ${result.wall_clock_ms}ms calls=${result.trace.length}`,
          );
        }
      }
    }
  }

  writeFileSync(join(OUT_DIR, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));

  // Aggregate report
  console.log("\n────────────────────────────────────────────────────");
  console.log(" COMPLIANCE RESULTS (strict | lenient)");
  console.log("────────────────────────────────────────────────────");

  for (const model of MODELS_TO_TEST) {
    for (const strength of STRENGTHS) {
      const subset = results.filter((r) => r.model === model && r.strength === strength);
      const strictPassed = subset.filter((r) => r.compliance_strict.passed).length;
      const lenientPassed = subset.filter((r) => r.compliance_lenient.passed).length;
      const total = subset.length;
      const avgWall = Math.round(subset.reduce((s, r) => s + r.wall_clock_ms, 0) / total);
      const avgPromptTok = Math.round(subset.reduce((s, r) => s + r.prompt_tokens_total, 0) / total);
      const finishStats = subset.reduce((acc, r) => {
        acc[r.finished] = (acc[r.finished] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log(
        `${model.padEnd(20)} ${strength.padEnd(11)}  strict=${strictPassed}/${total} (${Math.round((strictPassed / total) * 100)}%)  lenient=${lenientPassed}/${total} (${Math.round((lenientPassed / total) * 100)}%)  avgWall=${avgWall}ms  avgPrompt=${avgPromptTok}tok  finish=${JSON.stringify(finishStats)}`,
      );
    }
  }
  console.log("────────────────────────────────────────────────────");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
