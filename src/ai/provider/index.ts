import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import { LocalProvider } from './local';
import type { MasterProvider, ProviderName } from './types';

let _anthropic: AnthropicProvider | null = null;
let _openai: OpenAIProvider | null = null;
let _gemini: GeminiProvider | null = null;
let _local: LocalProvider | null = null;

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
  if (name === 'local') {
    if (!_local) _local = new LocalProvider();
    return _local;
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
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini' || raw === 'local') {
    return getProviderByName(raw);
  }
  throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
}

/** Test/dev-only helper: clear the cached singletons. */
export function _resetMasterProviderForTests(): void {
  _anthropic = null;
  _openai = null;
  _gemini = null;
  _local = null;
}

export type { MasterProvider, ProviderName, CloudProviderName } from './types';
export { isCloudProvider } from './types';
