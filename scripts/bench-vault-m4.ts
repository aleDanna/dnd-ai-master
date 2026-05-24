#!/usr/bin/env tsx
/**
 * scripts/bench-vault-m4.ts — Manual M4 benchmark runner for the vault path.
 *
 * Why M4-only:
 *   The chosen primary model (qwen3:30b-a3b-instruct-2507-q4_K_M) uses MoE
 *   A3B routing — only 3B params active per token. On M5 Pro dev (307 GB/s
 *   memory bandwidth) the model is FASTER than on M4 (120 GB/s) despite
 *   the bandwidth ratio that would predict the opposite. CI-on-dev numbers
 *   therefore don't validate REQ-021 (warm wall-clock < 10s on M4 prod).
 *   The bench MUST run on the M4 to be decision-grade.
 *
 * Prerequisites (the script's pre-flight enforces #1, #3, #4):
 *   1. A test session with campaign.settings.masterBackend = 'vault'
 *   2. A Clerk session JWT (extract from devtools — see plan 08 README)
 *   3. Ollama reachable at OLLAMA_BASE_URL (or http://localhost:11434)
 *   4. Vault migrated (pnpm migrate-handbook-to-vault)
 *
 * The 5 prompts probe rules + abilities + race traits — exercising different
 * vault dirs and the model's pretrained-knowledge fallback for empty
 * Phase-01 catalogs (REQ-021 vehicle).
 *
 * Reference baselines from spike 004 (.claude/skills/spike-findings-dnd-ai-master/
 * references/performance.md):
 *   - Vault warm wall-clock target on M4: < 10s (gate)
 *   - Spike-measured: 3.78s warm vs 26.05s baked (-85.5%)
 *   - Vault avg prompt_eval_count: ~3-5K (vs baked ~8.8K)
 *
 * Usage:
 *   pnpm bench-vault-m4 --session=<uuid> --user-jwt=<clerk-token>
 *
 * Optional:
 *   --host=<url>     (default http://localhost:3000)
 *   --turns=<n>      (default 5)
 *   --out=<path>     (default ./bench-vault-m4-<ts>.json)
 */
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { aiUsage, campaigns, sessions } from '@/db/schema';
import { resolveMasterBackend } from '@/lib/preferences';

interface CliArgs {
  session: string;
  userJwt: string;
  host: string;
  turns: number;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    host: 'http://localhost:3000',
    turns: 5,
    out: `./bench-vault-m4-${Date.now()}.json`,
  };
  for (const arg of argv) {
    if (arg.startsWith('--session=')) args.session = arg.slice('--session='.length);
    else if (arg.startsWith('--user-jwt=')) args.userJwt = arg.slice('--user-jwt='.length);
    else if (arg.startsWith('--host=')) args.host = arg.slice('--host='.length);
    else if (arg.startsWith('--turns=')) args.turns = Number(arg.slice('--turns='.length));
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }
  if (!args.session) { console.error('Missing --session=<uuid>'); process.exit(2); }
  if (!args.userJwt) { console.error('Missing --user-jwt=<clerk-token>'); process.exit(2); }
  return args as CliArgs;
}

const PROMPTS = [
  'Quanto danno fa Fireball al livello 5?',
  'Quali sono le condizioni che un Paladino può rimuovere con Lay on Hands?',
  'Come funziona il vantaggio in 5e? Quando si applica e quando si annulla?',
  'Quanta velocità ha un Tiefling? E cosa fa la sua resistenza al fuoco?',
  'Quante slot di livello 3 ha uno Wizard di livello 5?',
];

interface TurnResult {
  turn: number;
  prompt: string;
  wallMs: number;
  promptEvalCount: number | null;
  evalCount: number | null;
  promptEvalMs: number | null;
  evalMs: number | null;
  loadMs: number | null;
}

async function preflight(sessionId: string): Promise<void> {
  // 1. Vault migrated
  const vaultIndex = resolve(process.cwd(), 'data/vault/handbook/index.md');
  if (!existsSync(vaultIndex)) {
    console.error(`Vault not migrated. Run \`pnpm migrate-handbook-to-vault\` first.`);
    console.error(`Expected file: ${vaultIndex}`);
    process.exit(2);
  }

  // 2. Session exists + campaign has vault flag
  const [row] = await db
    .select({ sessionId: sessions.id, campaignId: sessions.campaignId, settings: campaigns.settings })
    .from(sessions)
    .innerJoin(campaigns, eq(campaigns.id, sessions.campaignId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) {
    console.error(`Session ${sessionId} not found.`);
    process.exit(2);
  }
  const backend = resolveMasterBackend(row.settings.masterBackend);
  if (backend !== 'vault') {
    console.error(`Campaign ${row.campaignId} is on '${backend}' backend, not 'vault'.`);
    console.error(`Flip via: UPDATE campaigns SET settings = jsonb_set(settings, '{masterBackend}', '"vault"') WHERE id = '${row.campaignId}';`);
    process.exit(2);
  }

  // 3. Ollama reachable
  const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${ollamaBase}/api/tags`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    console.error(`Ollama unreachable at ${ollamaBase}: ${e instanceof Error ? e.message : String(e)}`);
    console.error('Start Ollama (e.g. `ollama serve`) and try again.');
    process.exit(2);
  }
}

async function runTurn(args: CliArgs, prompt: string, turnIndex: number, t0Cutoff: Date): Promise<TurnResult> {
  const t0 = Date.now();
  // POST the turn.
  const res = await fetch(`${args.host}/api/sessions/${args.session}/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cookie': `__session=${args.userJwt}`,
    },
    body: JSON.stringify({ message: prompt }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`POST /turn failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  // Wait for the ai_usage row to land. Poll every 200ms up to 60s.
  let usageRow: typeof aiUsage.$inferSelect | undefined;
  for (let i = 0; i < 300; i += 1) {
    const [r] = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.sessionId, args.session), gt(aiUsage.createdAt, t0Cutoff), eq(aiUsage.endpoint, 'master')))
      .orderBy(desc(aiUsage.createdAt))
      .limit(1);
    if (r) { usageRow = r; break; }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  const wallMs = Date.now() - t0;
  if (!usageRow) {
    console.warn(`[turn ${turnIndex + 1}] no ai_usage row landed within 60s (wall=${wallMs}ms)`);
    return {
      turn: turnIndex + 1,
      prompt,
      wallMs,
      promptEvalCount: null,
      evalCount: null,
      promptEvalMs: null,
      evalMs: null,
      loadMs: null,
    };
  }
  return {
    turn: turnIndex + 1,
    prompt,
    wallMs,
    promptEvalCount: usageRow.inputTokens,
    evalCount: usageRow.outputTokens,
    promptEvalMs: usageRow.promptEvalDurationMs,
    evalMs: usageRow.evalDurationMs,
    loadMs: usageRow.loadDurationMs,
  };
}

function summarize(results: TurnResult[]): void {
  const valid = results.filter((r) => r.wallMs > 0);
  const wallTimes = valid.map((r) => r.wallMs).sort((a, b) => a - b);
  const mean = Math.round(wallTimes.reduce((s, n) => s + n, 0) / wallTimes.length);
  const median = wallTimes[Math.floor(wallTimes.length / 2)] ?? 0;
  const max = wallTimes[wallTimes.length - 1] ?? 0;
  const meanPtok = Math.round(
    valid.reduce((s, r) => s + (r.promptEvalCount ?? 0), 0) / valid.length,
  );
  const gate = max < 10_000;

  console.log('\n────────────────────────────────────────────────────');
  console.log(' VAULT PATH — M4 BENCHMARK');
  console.log('────────────────────────────────────────────────────');
  console.log(' turn  wall_ms  ptok    etok    pe_ms   ev_ms   load_ms');
  for (const r of results) {
    const ptok = r.promptEvalCount ?? '-';
    const etok = r.evalCount ?? '-';
    const pe = r.promptEvalMs ?? '-';
    const ev = r.evalMs ?? '-';
    const load = r.loadMs ?? '-';
    console.log(`  ${String(r.turn).padStart(2)}   ${String(r.wallMs).padStart(6)}  ${String(ptok).padStart(6)}  ${String(etok).padStart(6)}  ${String(pe).padStart(6)}  ${String(ev).padStart(6)}  ${String(load).padStart(6)}`);
  }
  console.log('────────────────────────────────────────────────────');
  console.log(` mean wall_ms:     ${mean} (target < 10000)`);
  console.log(` median wall_ms:   ${median}`);
  console.log(` max wall_ms:      ${max}`);
  console.log(` mean prompt_eval: ${meanPtok} (vs baked baseline ~8.8K)`);
  console.log(` REQ-021 gate:     ${gate ? '✓ PASS' : '✗ FAIL'}  (max wall < 10s)`);
  console.log('────────────────────────────────────────────────────');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const turns = Math.min(args.turns, PROMPTS.length);
  const prompts = PROMPTS.slice(0, turns);
  console.log(`Pre-flight checks for session ${args.session}...`);
  await preflight(args.session);
  console.log('  ✓ Vault migrated, session has masterBackend=vault, Ollama reachable.');

  console.log(`\nRunning ${turns} turn(s) against ${args.host}...`);
  const startCutoff = new Date(Date.now() - 1000); // tolerate 1s clock skew
  const results: TurnResult[] = [];
  for (let i = 0; i < turns; i += 1) {
    const promptText = prompts[i]!;
    const r = await runTurn(args, promptText, i, startCutoff);
    results.push(r);
    console.log(`[turn ${r.turn}] "${promptText.slice(0, 40)}…" wall=${r.wallMs}ms ptok=${r.promptEvalCount ?? '-'} etok=${r.evalCount ?? '-'}`);
  }

  summarize(results);

  const outPath = resolve(args.out);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outPath}`);

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('Bench failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
