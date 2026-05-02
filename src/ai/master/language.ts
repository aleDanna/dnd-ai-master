import { getMasterProvider } from '@/ai/provider';

export interface DetectInput {
  text: string;
  /** Test override: a stub with `detect(text)` returning a 2-letter code. */
  stub?: { detect: (text: string) => Promise<string> };
  userId?: string;
  sessionId?: string;
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
  return getMasterProvider().detectLanguage({
    text: input.text,
    userId: input.userId,
    sessionId: input.sessionId,
  });
}
