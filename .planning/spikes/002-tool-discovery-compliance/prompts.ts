export type PromptStrength = "V1_mild" | "V2_strict";

export interface CompliancePromptConfig {
  vaultRoot: string;
  campaignId: string;
  strength: PromptStrength;
}

const KNOWLEDGE_BLOCK = (cfg: CompliancePromptConfig): string => `## Knowledge layout

Your knowledge lives in a markdown vault at root '${cfg.vaultRoot}'.

- Static knowledge: \`/handbook/<category>/<id>.md\` — e.g. \`/handbook/spells/fireball.md\`, \`/handbook/monsters/<name>.md\`
- Active campaign: \`/campaigns/${cfg.campaignId}/\` — entry point \`/campaigns/${cfg.campaignId}/index.md\`
- Characters: \`/campaigns/${cfg.campaignId}/characters/<name>.md\`

The complete list of available tools is at \`/tools/index.md\`. Each tool has a documentation file at \`/tools/<tool-name>.md\` describing its schema.`;

const V1_PROTOCOL = `## Tool usage protocol

Before invoking any tool by name, you MUST first call \`read_vault\` to read \`/tools/<tool-name>.md\` and learn its full schema.

Once you have read a tool's documentation in this conversation, you may use it without re-reading.`;

const V2_PROTOCOL = `## Tool usage protocol (MANDATORY)

**RULE:** You MUST NEVER invoke a tool whose schema you have not first read from \`/tools/<tool-name>.md\`. Violating this rule produces undefined behavior and corrupted game state.

**Required sequence for every turn that needs a tool:**

1. If you don't know what tools exist, your FIRST action is \`read_vault({"path": "/tools/index.md"})\`.
2. Before invoking any specific tool \`X\` for the first time, your next action MUST be \`read_vault({"path": "/tools/X.md"})\`.
3. ONLY AFTER reading \`/tools/X.md\` may you invoke \`X\` with its proper arguments.

**Concrete example.** To answer a question that requires reading the Fireball spell entry, the correct call sequence is:

\`\`\`
1. read_vault({"path": "/tools/index.md"})              ← discover what tools exist
2. read_vault({"path": "/tools/read_vault.md"})         ← learn read_vault's schema
3. read_vault({"path": "/handbook/spells/fireball.md"}) ← now you may use read_vault for content
4. read_vault({"path": "/tools/end_turn.md"})           ← learn end_turn's schema
5. end_turn({"response": "..."})                         ← only now may you call end_turn
\`\`\`

Steps 1, 2, 4 are MANDATORY before steps 3 and 5. Skipping them is a protocol violation.

Once you have read a tool's documentation in the current conversation, you may reuse the tool without re-reading.`;

export function buildCompliancePrompt(cfg: CompliancePromptConfig): string {
  const protocol = cfg.strength === "V2_strict" ? V2_PROTOCOL : V1_PROTOCOL;

  return `You are an experienced D&D 5e Dungeon Master.

${KNOWLEDGE_BLOCK(cfg)}

${protocol}

## Behavior

When a player asks about D&D content (spells, rules, character stats), look up the relevant file using \`read_vault\` after following the tool usage protocol above. Then respond by calling \`end_turn\` with your narrative answer.

Keep responses concise and in-character as the DM.`;
}

export interface Scenario {
  id: string;
  query: string;
  expected_tools: string[];
  expected_reads: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "fireball-5th",
    query: "How much damage does a Fireball do when cast with a 5th-level spell slot?",
    expected_tools: ["read_vault", "end_turn"],
    expected_reads: ["/handbook/spells/fireball.md"],
  },
  {
    id: "magic-missile-3rd",
    query: "How many darts does Magic Missile create when cast at 3rd level?",
    expected_tools: ["read_vault", "end_turn"],
    expected_reads: ["/handbook/spells/magic-missile.md"],
  },
  {
    id: "aragorn-level",
    query: "What level is Aragorn?",
    expected_tools: ["read_vault", "end_turn"],
    expected_reads: ["/campaigns/test/characters/aragorn.md"],
  },
  {
    id: "list-spells",
    query: "List every spell available in the handbook.",
    expected_tools: ["list_vault", "end_turn"],
    expected_reads: [],
  },
  {
    id: "cure-wounds-on-aragorn",
    query: "If I cast Cure Wounds on Aragorn with my +3 spellcasting modifier, what range of HP does he recover?",
    expected_tools: ["read_vault", "end_turn"],
    expected_reads: ["/handbook/spells/cure-wounds.md"],
  },
];
