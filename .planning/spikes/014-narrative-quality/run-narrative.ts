import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { SCENARIOS, type NarrativeScenario } from "./scenarios";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const KEEP_ALIVE = "30m";
const OUT_DIR = resolve(__dirname, "results");

const MODELS = (process.env.NARRATIVE_MODELS ?? "qwen3:30b-a3b-instruct-2507-q4_K_M,qwen3:30b-a3b-instruct-2507,qwen3:30b-a3b,mistral-small3.2:24b").split(",");

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

// NOTE: NO "Keep responses concise" — we want prose here. Italian forced
// per user preference. Vault knowledge not loaded for these scenarios —
// the test is about prose, not tool sequencing (compliance/wall-clock
// already validated in 002-004).
const SYSTEM_PROMPT = `Sei un esperto Dungeon Master di D&D 5e. Stai conducendo una sessione in italiano. Rispondi sempre in italiano, mai in inglese. Usa uno stile vivido, evocativo, e cinematografico quando appropriato. Mostra non dire (show don't tell). Evita cliché logorati. Non chiedere "cosa fai?" alla fine se la domanda non lo richiede.`;

async function chat(model: string, messages: OllamaMessage[]): Promise<OllamaResponse> {
  const body = {
    model,
    messages,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.8, num_predict: 2000, top_p: 0.9 },
  };
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()) as OllamaResponse;
}

interface NarrativeResult {
  scenario_id: string;
  dimension: string;
  model: string;
  wall_ms: number;
  prompt_tokens: number;
  eval_tokens: number;
  prefill_ms: number;
  eval_ms: number;
  response: string;
}

async function runOne(model: string, scenario: NarrativeScenario): Promise<NarrativeResult> {
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: scenario.user_message },
  ];
  const start = Date.now();
  const res = await chat(model, messages);
  const wall = Date.now() - start;
  return {
    scenario_id: scenario.id,
    dimension: scenario.dimension,
    model,
    wall_ms: wall,
    prompt_tokens: res.prompt_eval_count ?? 0,
    eval_tokens: res.eval_count ?? 0,
    prefill_ms: res.prompt_eval_duration ? Math.round(res.prompt_eval_duration / 1e6) : 0,
    eval_ms: res.eval_duration ? Math.round(res.eval_duration / 1e6) : 0,
    response: res.message?.content?.trim() ?? "(empty)",
  };
}

function renderMarkdownReport(results: NarrativeResult[]): string {
  const out: string[] = [];
  out.push("# Spike 014: Narrative Quality Comparison\n");
  out.push(`Run on hardware: ${process.platform} ${process.arch}, models: ${MODELS.join(", ")}\n`);
  out.push("**Read each scenario, compare the 4 model responses, then fill the Human Verdict table at the bottom of each section.**\n");
  out.push("---\n");

  for (const scenario of SCENARIOS) {
    const subset = results.filter((r) => r.scenario_id === scenario.id);
    out.push(`## Scenario: ${scenario.dimension}\n`);
    out.push(`**Prompt:**\n\n> ${scenario.user_message.split("\n").join("\n> ")}\n`);
    out.push(`**Rubric (what good looks like):**\n\n> ${scenario.rubric}\n`);
    out.push("---\n");

    for (const r of subset) {
      out.push(`### Model: \`${r.model}\`\n`);
      out.push(`*wall=${r.wall_ms} ms · prompt=${r.prompt_tokens} tok · eval=${r.eval_tokens} tok · prefill=${r.prefill_ms} ms · decode=${r.eval_ms} ms*\n`);
      out.push("```");
      out.push(r.response);
      out.push("```\n");
    }

    out.push("**Human verdict — rank 1 (best) to 4 (worst):**\n");
    out.push("| Model | Rank | Why |");
    out.push("|---|---|---|");
    for (const r of subset) {
      out.push(`| \`${r.model}\` | __ | _fill in_ |`);
    }
    out.push("\n---\n");
  }

  out.push("## Overall scoring\n");
  out.push("After filling per-scenario ranks, aggregate the winner here.\n");
  out.push("| Model | Total rank (lower = better) | Notes |");
  out.push("|---|---|---|");
  for (const m of MODELS) {
    out.push(`| \`${m}\` | __ | _summary impression_ |`);
  }
  out.push("\n**Recommendation:** _which model goes into the design as primary for narrative-heavy turns?_\n");

  return out.join("\n");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`▶ Running ${MODELS.length} models × ${SCENARIOS.length} scenarios = ${MODELS.length * SCENARIOS.length} turns\n`);

  const results: NarrativeResult[] = [];

  for (const model of MODELS) {
    console.log(`\n=== Model: ${model} ===`);
    for (const scenario of SCENARIOS) {
      process.stdout.write(`  [${scenario.id}] ... `);
      try {
        const r = await runOne(model, scenario);
        results.push(r);
        console.log(`wall=${r.wall_ms}ms ptok=${r.prompt_tokens} etok=${r.eval_tokens} chars=${r.response.length}`);
      } catch (e) {
        console.log(`FAIL: ${(e as Error).message}`);
        results.push({
          scenario_id: scenario.id,
          dimension: scenario.dimension,
          model,
          wall_ms: 0,
          prompt_tokens: 0,
          eval_tokens: 0,
          prefill_ms: 0,
          eval_ms: 0,
          response: `ERROR: ${(e as Error).message}`,
        });
      }
    }
  }

  const ts = Date.now();
  writeFileSync(join(OUT_DIR, `raw-${ts}.json`), JSON.stringify(results, null, 2));
  const reportPath = join(OUT_DIR, `comparison-${ts}.md`);
  writeFileSync(reportPath, renderMarkdownReport(results));

  console.log("\n────────────────────────────────────────────────────");
  console.log(" NARRATIVE COMPARISON COMPLETE");
  console.log("────────────────────────────────────────────────────");
  console.log(` Raw JSON: ${OUT_DIR}/raw-${ts}.json`);
  console.log(` Markdown report: ${reportPath}`);
  console.log("────────────────────────────────────────────────────");
  console.log("\nNow open the markdown report and read each scenario side-by-side.");
  console.log("Fill in the 'Human verdict' tables, then update the spike 014 README");
  console.log("Results section with your final pick.\n");

  // Quick wall-clock summary as a sanity check
  console.log(" Wall-clock summary (avg per model across scenarios):");
  for (const m of MODELS) {
    const subset = results.filter((r) => r.model === m && r.wall_ms > 0);
    if (subset.length === 0) continue;
    const avg = Math.round(subset.reduce((s, r) => s + r.wall_ms, 0) / subset.length);
    const avgEvalTok = Math.round(subset.reduce((s, r) => s + r.eval_tokens, 0) / subset.length);
    const avgChars = Math.round(subset.reduce((s, r) => s + r.response.length, 0) / subset.length);
    console.log(`  ${m.padEnd(46)} avg_wall=${avg}ms  avg_eval_tok=${avgEvalTok}  avg_chars=${avgChars}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
