import { WIZARD_SYSTEM_PROMPT } from './system-prompt';
import { PROPOSE_CHOICE_TOOL } from './tools';
import { getMasterProvider } from '@/ai/provider';

export interface ProposeInput {
  step: 'race' | 'class' | 'background' | 'abilities' | 'skills' | 'equipment' | 'identity';
  userPrompt: string;
  srdContext: string;             // pre-built reference text injected into the prompt
  currentChoices: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
}

export interface Proposal {
  step: string;
  value: unknown;
  reasoning: string;
}

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

  const out = await getMasterProvider().proposeWizard({
    systemPrompt: WIZARD_SYSTEM_PROMPT,
    toolDefinition: PROPOSE_CHOICE_TOOL,
    userMessage,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  return out.toolInput as unknown as Proposal;
}
