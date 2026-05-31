import { describe, it, expect } from 'vitest';
import { initialCampaignSettings } from '@/campaigns/initial-settings';
import type { UserPreferences } from '@/db/schema';

/**
 * New campaigns should be born on the VAULT path by default (post-migration),
 * instead of inheriting the legacy baked/postgres fallback — which produces a
 * ~116k-char system prompt that overruns OLLAMA_NUM_CTX and stalls the first
 * turn.
 *
 * initialCampaignSettings(prefs) is the PURE settings-defaulting step extracted
 * from createCampaign: it snapshots the host's preferences (dropping the
 * per-viewer ttsAutoplay) and, when the host has NO explicit masterBackend,
 * defaults the new campaign's LLM tool surface to the vault path
 * (masterBackend:'vault') so the minimal prompt is used instead of the 116k
 * baked one. sourceOfTruth/vaultMutations are deliberately NOT forced on —
 * reads stay on Postgres (no events.md seed required; never half-seeded), and
 * the write/event-sourcing path stays opt-in per campaign. An explicit host
 * choice is always preserved.
 */

function prefs(over: Partial<UserPreferences> = {}): UserPreferences {
  return { aiProvider: 'local', ...over } as UserPreferences;
}

describe('initialCampaignSettings', () => {
  it('defaults a new campaign to the vault tool surface when the host has no explicit masterBackend', () => {
    const s = initialCampaignSettings(prefs());
    expect(s.masterBackend).toBe('vault');
  });

  it('does NOT force sourceOfTruth/vaultMutations on the defaulted campaign (no seed required, reads stay Postgres)', () => {
    const s = initialCampaignSettings(prefs());
    // Left unset → resolvers fall back to postgres / mutations-off. The vault
    // write path (which needs an events.md seed) stays opt-in.
    expect(s.sourceOfTruth).toBeUndefined();
    expect(s.vaultMutations).toBeUndefined();
  });

  it('preserves an explicit baked choice (does NOT force vault over the host preference)', () => {
    const s = initialCampaignSettings(prefs({ masterBackend: 'baked' } as Partial<UserPreferences>));
    expect(s.masterBackend).toBe('baked');
  });

  it('preserves an explicit vault choice without inventing sourceOfTruth/mutations', () => {
    const s = initialCampaignSettings(prefs({ masterBackend: 'vault' } as Partial<UserPreferences>));
    expect(s.masterBackend).toBe('vault');
  });

  it('drops the per-viewer ttsAutoplay flag from the snapshot', () => {
    const s = initialCampaignSettings(prefs({ ttsAutoplay: true } as Partial<UserPreferences>));
    expect('ttsAutoplay' in s).toBe(false);
  });

  it('carries through unrelated host preferences (provider/model/etc.)', () => {
    const s = initialCampaignSettings(
      prefs({ aiProvider: 'openai', aiMasterModel: 'gpt-5', manualRolls: true } as Partial<UserPreferences>),
    );
    expect(s.aiProvider).toBe('openai');
    expect(s.aiMasterModel).toBe('gpt-5');
    expect(s.manualRolls).toBe(true);
  });

  it('does not mutate the input preferences object', () => {
    const p = prefs({ ttsAutoplay: true } as Partial<UserPreferences>);
    const snapshot = JSON.stringify(p);
    initialCampaignSettings(p);
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
