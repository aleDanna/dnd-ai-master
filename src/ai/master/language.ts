import { getMasterProvider, getProviderByName, isCloudProvider } from '@/ai/provider';
import type { ProviderName as AiModelsProviderName } from '@/lib/ai-models';

export interface DetectInput {
  text: string;
  /** Test override: a stub with `detect(text)` returning a 2-letter code. */
  stub?: { detect: (text: string) => Promise<string> };
  userId?: string;
  sessionId?: string;
  /** Optional provider override (per-user). When unset, falls back to MASTER_PROVIDER env. */
  provider?: AiModelsProviderName;
}

export async function detectLanguage(input: DetectInput): Promise<string | null> {
  if (input.stub) {
    try {
      const code = (await input.stub.detect(input.text)).trim().toLowerCase();
      return /^[a-z]{2}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }
  // Local providers are not supported at this layer; should be caught at route level
  if (input.provider && !isCloudProvider(input.provider)) {
    throw new Error(`detectLanguage does not support provider: ${input.provider}`);
  }
  const provider = input.provider ? getProviderByName(input.provider) : getMasterProvider();
  return provider.detectLanguage({
    text: input.text,
    userId: input.userId,
    sessionId: input.sessionId,
  });
}
