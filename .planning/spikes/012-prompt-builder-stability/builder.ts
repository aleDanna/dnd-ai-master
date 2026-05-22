import { createHash } from "node:crypto";

export interface PromptInput {
  vaultRoot: string;
  campaignId: string;
  toolCount: number;
}

/**
 * Stable system prompt builder. Pure function: same inputs → same output, byte-for-byte.
 * Forbidden in this function: Date, Math.random, process.hrtime, crypto.randomUUID,
 * environment-dependent reads.
 */
export function buildSystemPrompt(input: PromptInput): string {
  return [
    `You are an experienced D&D 5e Dungeon Master.`,
    ``,
    `## Knowledge layout`,
    ``,
    `Your knowledge lives in a markdown vault at root '${input.vaultRoot}'.`,
    `- Static knowledge: /handbook/<category>/<id>.md`,
    `- Active campaign: /campaigns/${input.campaignId}/`,
    ``,
    `## Tool usage protocol`,
    ``,
    `If you don't know what tools exist, your FIRST action is to read /tools/index.md.`,
    `After that, use any of the ${input.toolCount} listed tools directly.`,
    ``,
    `Keep responses concise.`,
  ].join("\n");
}

/**
 * Forbidden patterns regex. Source code must not embed runtime-varying values
 * directly in the system prompt template. Validate ONLY the builder's source,
 * not its output (the output is checked via hash equality).
 */
const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Date.now", re: /Date\.now\(/ },
  { name: "new Date(", re: /new\s+Date\(/ },
  { name: "Math.random", re: /Math\.random\(/ },
  { name: "process.hrtime", re: /process\.hrtime/ },
  { name: "randomUUID", re: /randomUUID\(/ },
  { name: "process.env", re: /process\.env\./ },
  { name: "hostname", re: /\.hostname\(/ },
];

export function lintBuilderSource(source: string): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    if (re.test(source)) violations.push(name);
  }
  return { ok: violations.length === 0, violations };
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
