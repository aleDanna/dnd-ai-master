import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import type { MasterProvider, ProviderName } from './types';

let _provider: MasterProvider | null = null;
let _selected: ProviderName | null = null;

/** Returns a cached MasterProvider instance based on MASTER_PROVIDER env. Lazy. */
export function getMasterProvider(): MasterProvider {
  if (_provider) return _provider;
  const raw = (process.env.MASTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (raw === 'anthropic') {
    _provider = new AnthropicProvider();
  } else if (raw === 'openai') {
    _provider = new OpenAIProvider();
  } else {
    throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
  }
  _selected = _provider.name;
  return _provider;
}

/** Test/dev-only helper: clear the cached singleton (used to re-read env across tests). */
export function _resetMasterProviderForTests(): void {
  _provider = null;
  _selected = null;
}

export function getCurrentProviderName(): ProviderName | null {
  return _selected;
}

export type { MasterProvider, ProviderName } from './types';
