import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';

export class GeminiProvider implements MasterProvider {
  readonly name = 'gemini' as const;

  async completeMessage(_input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    throw new Error('GeminiProvider.completeMessage not implemented yet');
  }

  async detectLanguage(_input: DetectLanguageInput): Promise<string | null> {
    throw new Error('GeminiProvider.detectLanguage not implemented yet');
  }

  async proposeWizard(_input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    throw new Error('GeminiProvider.proposeWizard not implemented yet');
  }
}
