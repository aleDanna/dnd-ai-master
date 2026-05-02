import { getAnthropicClient, LANGUAGE_MODEL } from './anthropic-client';
import { recordUsage } from './usage';

const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);

function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

export interface DetectInput {
  text: string;
  /** Test override: a stub with `detect(text)` returning a 2-letter code. */
  stub?: { detect: (text: string) => Promise<string> };
  userId?: string;
  sessionId?: string;
}

export async function detectLanguage(input: DetectInput): Promise<string | null> {
  if (isTrivial(input.text)) return null;

  const detector = input.stub
    ? input.stub.detect
    : async (text: string): Promise<string> => {
        const client = getAnthropicClient();
        const resp = await client.messages.create({
          model: LANGUAGE_MODEL,
          max_tokens: 8,
          system: [
            {
              type: 'text',
              text: 'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.',
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: text }],
        });
        if (input.userId) {
          await recordUsage({
            userId: input.userId,
            sessionId: input.sessionId ?? null,
            endpoint: 'language',
            model: LANGUAGE_MODEL,
            usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens, cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0, cacheCreationTokens: resp.usage.cache_creation_input_tokens ?? 0 },
          });
        }
        const block = resp.content[0];
        if (!block || block.type !== 'text') throw new Error('language detector returned no text');
        return block.text.trim().toLowerCase();
      };

  try {
    const code = await detector(input.text);
    if (/^[a-z]{2}$/.test(code)) return code;
    return null;
  } catch {
    return null;
  }
}
