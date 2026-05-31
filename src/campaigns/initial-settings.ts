import type { CampaignSettings, UserPreferences } from '@/db/schema';

/**
 * Compute the initial `campaigns.settings` for a newly-created campaign.
 *
 * Snapshots the host's current preferences (so the campaign inherits whatever
 * the host had tuned) MINUS the per-viewer `ttsAutoplay` flag, then applies the
 * post-migration default: a new campaign is born on the VAULT path unless the
 * host explicitly chose a backend.
 *
 * Why default to vault (vault-llm-wiki migration): the legacy fallback is
 * `masterBackend: 'baked'` + `sourceOfTruth: 'postgres'`, which builds a
 * ~116k-char system prompt (SRD + handbook + tool contract). That overruns a
 * typical local `OLLAMA_NUM_CTX` (e.g. 16384) → multi-minute prefill → empty
 * first turn → the UI appears stuck. The vault path uses a ~6k-char minimal
 * prompt and is the intended runtime. New campaigns therefore default to
 * `masterBackend: 'vault'`, `sourceOfTruth: 'vault'`, `vaultMutations: true`.
 *
 * An EXPLICIT host `masterBackend` (vault or baked) is always preserved — this
 * only fills the default when the host left it unset. Pure: no DB, no clock,
 * no env; never mutates the input.
 */
export function initialCampaignSettings(hostPreferences: UserPreferences): CampaignSettings {
  // Drop the per-viewer ttsAutoplay (it stays a user-level preference).
  const { ttsAutoplay: _autoplay, ...rest } = hostPreferences;
  void _autoplay;
  const settings = { ...rest } as CampaignSettings;

  // Default ONLY the LLM tool surface to the vault path when the host left it
  // unset. This is the safe, self-contained fix for the legacy-prompt stall:
  //   - masterBackend:'vault'  → minimal vault system prompt (~6k), NOT the
  //     116k baked prompt that overruns OLLAMA_NUM_CTX and stalls turn 1.
  //   - sourceOfTruth stays 'postgres' (default) → reads come from Postgres, so
  //     NO events.md seed is required and the campaign is never in a broken
  //     half-seeded state. This is the validated Phase-01 vault-read posture.
  //   - vaultMutations stays off → the write/event-sourcing path (which DOES
  //     need a seed) is opt-in, enabled per-campaign via vault:flip when the
  //     operator wants combat mutations. Defaulting it on here without seeding
  //     events.md would produce zombie character state on the first mutation.
  // An explicit host choice (vault or baked) is always preserved untouched.
  if (settings.masterBackend === undefined) {
    settings.masterBackend = 'vault';
  }

  return settings;
}
