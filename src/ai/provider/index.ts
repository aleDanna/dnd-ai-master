import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import type { MasterProvider, ProviderName } from './types';

let _anthropic: AnthropicProvider | null = null;
let _openai: OpenAIProvider | null = null;
let _gemini: GeminiProvider | null = null;

/** Returns a cached MasterProvider instance for the named provider. Lazy. */
export function getProviderByName(name: ProviderName): MasterProvider {
  if (name === 'anthropic') {
    if (!_anthropic) _anthropic = new AnthropicProvider();
    return _anthropic;
  }
  if (name === 'openai') {
    if (!_openai) _openai = new OpenAIProvider();
    return _openai;
  }
  if (name === 'gemini') {
    if (!_gemini) _gemini = new GeminiProvider();
    return _gemini;
  }
  throw new Error(`unknown provider: ${String(name)}`);
}

/**
 * Backward-compatible env-based dispatcher. Used by tests and any callsite that
 * doesn't have a per-user preference (e.g. internal scripts). Per-user routes should
 * call getProviderByName(prefs.aiProvider) directly.
 */
export function getMasterProvider(): MasterProvider {
  const raw = (process.env.MASTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini') return getProviderByName(raw);
  throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
}

/** Test/dev-only helper: clear the cached singletons. */
export function _resetMasterProviderForTests(): void {
  _anthropic = null;
  _openai = null;
  _gemini = null;
}

export type { MasterProvider, ProviderName } from './types';
