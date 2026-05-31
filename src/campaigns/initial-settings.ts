import type { CampaignSettings, UserPreferences } from '@/db/schema';

/**
 * Compute the initial `campaigns.settings` for a newly-created campaign.
 *
 * Snapshots the host's current preferences (so the campaign inherits whatever
 * the host had tuned) MINUS the per-viewer `ttsAutoplay` flag, then applies the
 * post-migration default: a new campaign is born as a FULL vault campaign
 * unless the host explicitly chose otherwise.
 *
 * Why default to the full vault posture (vault-llm-wiki migration):
 *  - `masterBackend: 'vault'` → the minimal ~6k vault system prompt instead of
 *    the legacy ~116k baked prompt (SRD + handbook + tool contract) that
 *    overruns a typical local `OLLAMA_NUM_CTX` → multi-minute prefill → empty
 *    first turn → the UI appears stuck.
 *  - `vaultMutations: true` + `sourceOfTruth: 'vault'` → mechanics (combat,
 *    damage, rolls) actually apply and reads replay the event log. This is the
 *    intended runtime and is what makes a fresh campaign playable end-to-end.
 *
 * Why this is SAFE (and not the half-seeded "zombie state" the older, more
 * cautious default warned about): campaign creation ALWAYS seeds the vault.
 * `forge.ts` calls `seedCampaignVault()` unconditionally right after the row is
 * created, and `seed.ts` appends the genesis `campaign_initialized` event for
 * every vault campaign (gated only on `masterBackend === 'vault'`, NOT on
 * `vaultMutations`). So a vault read replays a real genesis and the first
 * mutation appends to a properly-seeded log. (Proven live: The Goblin Warren
 * runs with all three flags on and a one-line seeded events.md.)
 *
 * Explicit host choices always win, per-flag:
 *  - an explicit `masterBackend` (vault or baked) is preserved; a baked choice
 *    does NOT receive the vault-only flags.
 *  - an explicit `vaultMutations` / `sourceOfTruth` is preserved even on vault.
 *  - `manualRolls` defaults to true (so the 🎲 roll chip — and thus skill
 *    checks / attacks — work on a fresh campaign) only when the host left it
 *    unset; an explicit true OR false is preserved.
 *
 * Pure: no DB, no clock, no env; never mutates the input.
 */
export function initialCampaignSettings(hostPreferences: UserPreferences): CampaignSettings {
  // Drop the per-viewer ttsAutoplay (it stays a user-level preference).
  const { ttsAutoplay: _autoplay, ...rest } = hostPreferences;
  void _autoplay;
  const settings = { ...rest } as CampaignSettings;

  // Default the LLM tool surface to the vault path when the host left it unset.
  if (settings.masterBackend === undefined) {
    settings.masterBackend = 'vault';
  }

  // Full vault posture for any vault campaign (defaulted OR explicitly chosen),
  // preserving an explicit per-flag host value. Safe because events.md is always
  // seeded at creation (see seedCampaignVault in forge.ts / seed.ts).
  if (settings.masterBackend === 'vault') {
    if (settings.vaultMutations === undefined) {
      settings.vaultMutations = true;
    }
    if (settings.sourceOfTruth === undefined) {
      settings.sourceOfTruth = 'vault';
    }
  }

  // Manual rolls on by default so the in-app roll chip renders for skill checks
  // / attacks; an explicit host choice (true OR false) is preserved.
  if (settings.manualRolls === undefined) {
    settings.manualRolls = true;
  }

  // Hide difficulty numbers by default: the DC/AC is the DM's secret (DM-screen
  // convention) — players shouldn't see "(CD 12)" on the roll chip. The
  // manual-rolls block honours this (showDifficultyNumbers:false → the master
  // omits the numeric DC/AC from roll requests while still using it to judge
  // the result). An explicit host choice (true OR false) is preserved.
  if (settings.showDifficultyNumbers === undefined) {
    settings.showDifficultyNumbers = false;
  }

  return settings;
}
