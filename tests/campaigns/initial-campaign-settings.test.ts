import { describe, it, expect } from 'vitest';
import { initialCampaignSettings } from '@/campaigns/initial-settings';
import type { UserPreferences } from '@/db/schema';

/**
 * New campaigns are born as FULL vault campaigns by default ("vault completo
 * dalla nascita"). The legacy baked/postgres fallback produces a ~116k-char
 * system prompt that overruns OLLAMA_NUM_CTX and stalls the first turn; the
 * vault path uses a ~6k prompt and is the intended runtime.
 *
 * Crucially, this is SAFE to default fully on (vaultMutations + sourceOfTruth
 * vault) because campaign creation ALWAYS seeds events.md: forge.ts calls
 * seedCampaignVault() unconditionally for every vault campaign, and
 * seed.ts appends the genesis `campaign_initialized` event (gated only on
 * masterBackend === 'vault'). So vault reads replay a real genesis and the
 * first mutation appends to a properly-seeded log — no zombie/half-seeded
 * state. (Proven live: The Goblin Warren runs with all three flags on.)
 *
 * Policy:
 *  - host left masterBackend unset → masterBackend:'vault'.
 *  - effective backend === 'vault' → default vaultMutations:true and
 *    sourceOfTruth:'vault' (so combat/mechanics work out of the box), but an
 *    EXPLICIT host value for either flag always wins.
 *  - manualRolls defaults to true when the host hasn't set it (so the 🎲 roll
 *    chip — and thus skill checks / attacks — work on a fresh campaign); an
 *    explicit host choice (true OR false) is preserved.
 *  - an explicit baked choice is preserved and does NOT receive the vault-only
 *    flags.
 *  - the per-viewer ttsAutoplay flag is dropped; the input is never mutated.
 */

function prefs(over: Partial<UserPreferences> = {}): UserPreferences {
  return { aiProvider: 'local', ...over } as UserPreferences;
}

describe('initialCampaignSettings', () => {
  it('defaults a new campaign to the vault tool surface when the host has no explicit masterBackend', () => {
    const s = initialCampaignSettings(prefs());
    expect(s.masterBackend).toBe('vault');
  });

  it('defaults a defaulted-vault campaign to FULL vault: vaultMutations + sourceOfTruth vault', () => {
    const s = initialCampaignSettings(prefs());
    // events.md is always seeded at creation (forge → seedCampaignVault), so the
    // full vault posture is safe and makes combat/mechanics work immediately.
    expect(s.vaultMutations).toBe(true);
    expect(s.sourceOfTruth).toBe('vault');
  });

  it('defaults manualRolls on so the roll chip / skill checks work on a fresh campaign', () => {
    const s = initialCampaignSettings(prefs());
    expect(s.manualRolls).toBe(true);
  });

  it('preserves an explicit baked choice and does NOT add vault-only flags', () => {
    const s = initialCampaignSettings(prefs({ masterBackend: 'baked' } as Partial<UserPreferences>));
    expect(s.masterBackend).toBe('baked');
    expect(s.vaultMutations).toBeUndefined();
    expect(s.sourceOfTruth).toBeUndefined();
  });

  it('preserves an explicit vault choice and gives it the full vault posture too', () => {
    const s = initialCampaignSettings(prefs({ masterBackend: 'vault' } as Partial<UserPreferences>));
    expect(s.masterBackend).toBe('vault');
    expect(s.vaultMutations).toBe(true);
    expect(s.sourceOfTruth).toBe('vault');
  });

  it('preserves an explicit host vaultMutations:false even on a vault campaign', () => {
    const s = initialCampaignSettings(
      prefs({ masterBackend: 'vault', vaultMutations: false } as Partial<UserPreferences>),
    );
    expect(s.masterBackend).toBe('vault');
    expect(s.vaultMutations).toBe(false);
  });

  it('preserves an explicit host sourceOfTruth:postgres even on a vault campaign', () => {
    const s = initialCampaignSettings(
      prefs({ masterBackend: 'vault', sourceOfTruth: 'postgres' } as Partial<UserPreferences>),
    );
    expect(s.sourceOfTruth).toBe('postgres');
  });

  it('preserves an explicit host manualRolls:false (does not override it)', () => {
    const s = initialCampaignSettings(prefs({ manualRolls: false } as Partial<UserPreferences>));
    expect(s.manualRolls).toBe(false);
  });

  it('drops the per-viewer ttsAutoplay flag from the snapshot', () => {
    const s = initialCampaignSettings(prefs({ ttsAutoplay: true } as Partial<UserPreferences>));
    expect('ttsAutoplay' in s).toBe(false);
  });

  it('carries through unrelated host preferences (provider/model/etc.)', () => {
    const s = initialCampaignSettings(
      prefs({ aiProvider: 'openai', aiMasterModel: 'gpt-5' } as Partial<UserPreferences>),
    );
    expect(s.aiProvider).toBe('openai');
    expect(s.aiMasterModel).toBe('gpt-5');
  });

  it('does not mutate the input preferences object', () => {
    const p = prefs({ ttsAutoplay: true } as Partial<UserPreferences>);
    const snapshot = JSON.stringify(p);
    initialCampaignSettings(p);
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
