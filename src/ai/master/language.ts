import { getMasterProvider, getProviderByName, type ProviderName } from '@/ai/provider';

export interface DetectInput {
  text: string;
  /** Test override: a stub with `detect(text)` returning a 2-letter code. */
  stub?: { detect: (text: string) => Promise<string> };
  userId?: string;
  sessionId?: string;
  /** Optional provider override (per-user). When unset, falls back to MASTER_PROVIDER env. */
  provider?: ProviderName;
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
  const provider = input.provider ? getProviderByName(input.provider) : getMasterProvider();
  return provider.detectLanguage({
    text: input.text,
    userId: input.userId,
    sessionId: input.sessionId,
  });
}
