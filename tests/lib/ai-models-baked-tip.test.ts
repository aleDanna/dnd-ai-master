import { describe, it, expect } from 'vitest';
import { shouldShowBakedBuildTip, type BakedTipInput } from '@/lib/ai-models';

/**
 * Post-cutover staleness fix: the "Run pnpm build-local-models to enable
 * optimized variants (much faster turns)" tip is only meaningful on the
 * legacy BAKED path. On the vault path the system prompt is already minimal
 * (no MASTER_TOOL_CONTRACT / SRD / handbook), so a baked variant gives no
 * speed-up — the tip must NOT show there.
 *
 * shouldShowBakedBuildTip() is the pure predicate the settings UI uses to
 * gate the tip. Conditions to show (ALL required):
 *   - provider is 'local'           (baked variants are an Ollama-only concept)
 *   - Ollama is reachable
 *   - at least one local model is installed
 *   - NONE of the installed models is already baked
 *   - the campaign is NOT on the vault path (masterBackend !== 'vault')
 */

function base(over: Partial<BakedTipInput> = {}): BakedTipInput {
  return {
    provider: 'local',
    aiReachable: true,
    models: [{ kind: 'raw' }],
    masterBackend: 'baked',
    ...over,
  };
}

describe('shouldShowBakedBuildTip', () => {
  it('shows on a local + baked-backend campaign with only raw models installed', () => {
    expect(shouldShowBakedBuildTip(base())).toBe(true);
  });

  it('HIDES on the vault path even when all other conditions hold (post-cutover: baked gives no speedup)', () => {
    expect(shouldShowBakedBuildTip(base({ masterBackend: 'vault' }))).toBe(false);
  });

  it('hides when a baked variant is already installed', () => {
    expect(shouldShowBakedBuildTip(base({ models: [{ kind: 'raw' }, { kind: 'baked' }] }))).toBe(false);
  });

  it('hides for cloud providers (baked is Ollama-only)', () => {
    expect(shouldShowBakedBuildTip(base({ provider: 'anthropic' }))).toBe(false);
    expect(shouldShowBakedBuildTip(base({ provider: 'openai' }))).toBe(false);
    expect(shouldShowBakedBuildTip(base({ provider: 'gemini' }))).toBe(false);
  });

  it('hides when Ollama is unreachable', () => {
    expect(shouldShowBakedBuildTip(base({ aiReachable: false }))).toBe(false);
  });

  it('hides when no local models are installed', () => {
    expect(shouldShowBakedBuildTip(base({ models: [] }))).toBe(false);
  });

  it('treats a model with no kind field as non-baked (raw) for the all-raw check', () => {
    expect(shouldShowBakedBuildTip(base({ models: [{}] }))).toBe(true);
  });

  it('defaults an undefined masterBackend to non-vault (legacy campaigns still see the tip)', () => {
    // resolveMasterBackend default is env-driven; here undefined → not 'vault'
    // so the tip still shows for a legacy local+baked campaign.
    expect(shouldShowBakedBuildTip(base({ masterBackend: undefined }))).toBe(true);
  });
});
