import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

// Model aliases — automatically point at the latest minor version.
// Override via env to pin a specific dated snapshot (e.g. for reproducibility).
export const MASTER_MODEL = process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
export const LANGUAGE_MODEL = process.env.ANTHROPIC_LANGUAGE_MODEL ?? 'claude-haiku-4-5';
