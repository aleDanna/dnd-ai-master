import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { ForensicLog } from "./log";
import { buildSystemPrompt } from "./prompts";

const VAULT_ROOT = resolve(__dirname, "vault");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.SPIKE_MODEL ?? "qwen3:30b-a3b";
const KEEP_ALIVE = "30m";
const LAZY_TOOLS = (process.env.LAZY_TOOLS ?? "true") === "true";
const LOG_PATH = resolve(__dirname, `forensic-${Date.now()}.ndjson`);
const MAX_TOOL_CALLS = 12;

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

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

const TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "read_vault",
      description: "Read a markdown file by absolute vault path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path within vault, e.g. '/handbook/spells/fireball.md'" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_vault",
      description: "List children of a vault directory.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory path within vault, e.g. '/handbook/spells'" },
        },
        required: ["directory"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_turn",
      description: "Conclude turn and deliver final response to player.",
      parameters: {
        type: "object",
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
  if (!candidate.startsWith(VAULT_ROOT)) return null;
  return candidate;
}

function execReadVault(path: string): string {
  const abs = safeVaultPath(path);
  if (!abs) return "ERROR: path outside vault root";
  try {
    return readFileSync(abs, "utf8");
  } catch (e) {
    return `ERROR: file not found at ${path}`;
  }
}

function execListVault(directory: string): string {
  const abs = safeVaultPath(directory);
  if (!abs) return "ERROR: path outside vault root";
  try {
    const entries = readdirSync(abs);
    return entries
      .map((e) => {
        const full = join(abs, e);
        return statSync(full).isDirectory() ? `${e}/` : e;
      })
      .join("\n");
  } catch (e) {
    return `ERROR: directory not found at ${directory}`;
  }
}

async function ollamaChat(messages: OllamaMessage[], log: ForensicLog): Promise<OllamaChatResponse> {
  const body = {
    model: MODEL,
    messages,
    tools: TOOLS,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.7, num_predict: 2500 },
  };
  log.emit("ollama_request", { model: MODEL, message_count: messages.length, last_role: messages.at(-1)?.role });
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
    content_chars: json.message?.content?.length ?? 0,
    prompt_eval_count: json.prompt_eval_count,
    prompt_eval_duration_ms: json.prompt_eval_duration ? Math.round(json.prompt_eval_duration / 1e6) : 0,
    eval_count: json.eval_count,
    eval_duration_ms: json.eval_duration ? Math.round(json.eval_duration / 1e6) : 0,
    load_duration_ms: json.load_duration ? Math.round(json.load_duration / 1e6) : 0,
    total_duration_ms: json.total_duration ? Math.round(json.total_duration / 1e6) : 0,
  });
  return json;
}

async function runTurn(userMessage: string): Promise<void> {
  const log = new ForensicLog(LOG_PATH);
  log.emit("turn_start", { model: MODEL, lazy_tools: LAZY_TOOLS, user_message: userMessage });

  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt({ vaultRoot: "/vault", campaignId: "test", lazyTools: LAZY_TOOLS }) },
    { role: "user", content: userMessage },
  ];

  let finalResponse: string | null = null;
  let toolCallsTotal = 0;

  for (let i = 0; i < MAX_TOOL_CALLS && finalResponse === null; i++) {
    const res = await ollamaChat(messages, log);
    messages.push(res.message);

    const calls = res.message?.tool_calls ?? [];
    if (!calls.length) {
      log.emit("end_turn", { reason: "no_tool_calls", content_preview: res.message?.content?.slice(0, 200) ?? "" });
      finalResponse = res.message?.content ?? "(no content)";
      break;
    }

    for (const call of calls) {
      toolCallsTotal += 1;
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      log.emit("tool_call", { name, args });

      if (name === "end_turn") {
        finalResponse = (args.response as string) ?? "(empty response)";
        log.emit("end_turn", { reason: "end_turn_tool", response_preview: finalResponse.slice(0, 200) });
        break;
      }

      let result: string;
      if (name === "read_vault") {
        result = execReadVault((args.path as string) ?? "");
      } else if (name === "list_vault") {
        result = execListVault((args.directory as string) ?? "");
      } else {
        result = `ERROR: unknown tool ${name}`;
      }

      log.emit("tool_result", { name, ok: !result.startsWith("ERROR"), bytes: result.length, preview: result.slice(0, 200) });
      messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  if (finalResponse === null) {
    log.emit("error", { reason: "max_tool_calls_exceeded", limit: MAX_TOOL_CALLS });
    finalResponse = "(turn aborted: max tool calls exceeded)";
  }

  const summary = log.summary();
  log.emit("summary", { ...summary, total_tool_calls: toolCallsTotal });

  console.log("\n────────────────────────────────────────────────────");
  console.log(`▶ Model: ${MODEL}  |  Lazy tools: ${LAZY_TOOLS}`);
  console.log(`▶ User: ${userMessage}`);
  console.log("────────────────────────────────────────────────────");
  console.log("▶ Master response:");
  console.log(finalResponse);
  console.log("────────────────────────────────────────────────────");
  console.log(`▶ Tool calls: ${toolCallsTotal}`);
  console.log(`▶ Wall-clock: ${summary.duration_ms} ms`);
  console.log(`▶ Total prompt_eval: ${summary.total_prompt_eval_ms} ms (${summary.total_prompt_tokens} tokens)`);
  console.log(`▶ Total eval: ${summary.total_eval_ms} ms (${summary.total_eval_tokens} tokens)`);
  console.log(`▶ Forensic log: ${LOG_PATH}`);
  console.log("────────────────────────────────────────────────────\n");
}

const USER_MESSAGE = process.argv[2] ?? "How much damage does a Fireball do when cast with a 5th-level spell slot?";

runTurn(USER_MESSAGE).catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
