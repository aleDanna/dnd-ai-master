import Anthropic from '@anthropic-ai/sdk';
import { WIZARD_SYSTEM_PROMPT } from './system-prompt';
import { PROPOSE_CHOICE_TOOL } from './tools';

export interface ProposeInput {
  step: 'race' | 'class' | 'background' | 'abilities' | 'skills' | 'equipment' | 'identity';
  userPrompt: string;
  srdContext: string;             // pre-built reference text injected into the prompt
  currentChoices: Record<string, unknown>;
}

export interface Proposal {
  step: string;
  value: unknown;
  reasoning: string;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function proposeOne(input: ProposeInput): Promise<Proposal> {
  const userMessage = [
    `# SRD reference for step: ${input.step}`,
    input.srdContext,
    '',
    '# Current wizard state',
    JSON.stringify(input.currentChoices, null, 2),
    '',
    '# User description',
    input.userPrompt,
  ].join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',          // Plan D will switch to 4.6 when available
    max_tokens: 1024,
    system: WIZARD_SYSTEM_PROMPT,
    tools: [PROPOSE_CHOICE_TOOL],
    tool_choice: { type: 'tool', name: 'propose_choice' },
    messages: [{ role: 'user', content: userMessage }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'propose_choice') {
      const v = block.input as Proposal;
      return v;
    }
  }
  throw new Error('AI did not call propose_choice');
}
