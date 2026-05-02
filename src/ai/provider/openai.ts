import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';

export class OpenAIProvider implements MasterProvider {
  readonly name = 'openai' as const;
  async completeMessage(_input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    throw new Error('OpenAIProvider.completeMessage not yet implemented (Task 5)');
  }
  async detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('OpenAIProvider.detectLanguage not yet implemented (Task 6)');
  }
  async proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('OpenAIProvider.proposeWizard not yet implemented (Task 6)');
  }
}
