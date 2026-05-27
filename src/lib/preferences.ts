import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessions, users, campaigns,
  type UserPreferences,
  isMasterGuidanceLevel, isImageStylePreset, isNarrationPace,
  type CampaignSettings,
  type MasterBackend, isMasterBackend,
} from '@/db/schema';
import { isKnownProvider, isKnownMasterModel, isKnownImageProvider, isKnownImageModel, type ProviderName, type ImageProviderName } from '@/lib/ai-models';

export type { UserPreferences, MasterBackend };
export { isMasterBackend };
export {
  TTS_VOICES, type TtsVoice, isValidTtsVoice,
  TTS_MODELS, type TtsModel, isValidTtsModel,
  TTS_PROVIDERS, type TtsProvider, isValidTtsProvider,
  voicesForProvider, voicesForModel, modelsForProvider,
  defaultVoiceForProvider, defaultVoiceForModel, defaultModelForProvider,
  isValidVoiceForProvider, isValidVoiceForModel, isValidModelForProvider,
} from './tts-voices';
import {
  defaultVoiceForModel as ttsVoiceDefaultForModel,
  defaultModelForProvider as ttsModelDefault,
  voicesForModel as ttsVoicesForModel,
  modelsForProvider as ttsModelsFor,
  isValidTtsProvider,
  isValidTtsVoice,
  isValidTtsModel,
  isValidVoiceForModel,
  type TtsProvider,
} from './tts-voices';
import { isLocalEnvironment } from './local-services';

/**
 * True when the named local sub-engine is currently usable. Used by
 * validateSettingsPatch to gate 'local' acceptance, and by getResolvedPreferences
 * / getCampaignSettings to downgrade silently when the backing env disappears.
 *
 * For 'tts'/'image' surfaces, pass the engine slug (e.g. 'piper',
 * 'comfyui:flux-schnell', 'draw-things:...') to gate on the specific service.
 * Omit `subModel` to accept if ANY engine in the surface is enabled.
 */
function isLocalSurfaceAvailable(surface: 'ai' | 'tts' | 'image', subModel?: string): boolean {
  if (!isLocalEnvironment()) return false;
  if (surface === 'ai') return !!process.env.OLLAMA_BASE_URL;
  if (surface === 'tts') {
    if (subModel === 'piper') return !!process.env.PIPER_BASE_URL;
    return !!process.env.PIPER_BASE_URL;
  }
  if (subModel?.startsWith('draw-things:')) return !!process.env.DRAW_THINGS_BASE_URL;
  return !!process.env.DRAW_THINGS_BASE_URL;
}

/** Read-side downgrade: if the stored provider is 'local' but the local
 *  environment is gone (re-deploy without env, or running in production),
 *  fall back to the env default. The user sees the radio move on next
 *  Settings render but no broken requests fire. */
function resolveLocalAiProvider(stored: UserPreferences['aiProvider']): ProviderName {
  if (stored !== 'local') return stored ?? envDefaultProvider();
  if (!isLocalSurfaceAvailable('ai')) return envDefaultProvider();
  return 'local';
}

function resolveLocalTtsProvider(stored: UserPreferences['ttsProvider']): TtsProvider {
  if (stored !== 'local') return stored ?? envDefaultTtsProvider();
  if (!isLocalSurfaceAvailable('tts')) return envDefaultTtsProvider();
  return 'local';
}

function resolveLocalImageProvider(stored: UserPreferences['imageProvider']): ImageProviderName {
  if (stored !== 'local') return stored ?? envDefaultImageProvider();
  if (!isLocalSurfaceAvailable('image')) return envDefaultImageProvider();
  return 'local';
}

/**
 * Defaults are merged on top of stored prefs at read time. Provider/model defaults
 * cascade from env vars when user hasn't picked anything; if env is also unset,
 * fall back to anthropic + claude-sonnet-4-5 (the historical default).
 */
function envDefaultProvider(): ProviderName {
  const raw = (process.env.MASTER_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'gemini') return 'gemini';
  if (raw === 'local') return 'local';
  return 'anthropic';
}

function envDefaultMasterModel(provider: ProviderName): string {
  if (provider === 'local') return '';
  if (provider === 'openai') return process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
  if (provider === 'gemini') return process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
  return process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
}

function envDefaultImageProvider(): ImageProviderName {
  const raw = (process.env.IMAGE_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'gemini') return 'gemini';
  if (raw === 'local') return 'local';
  return 'openai';
}

function envDefaultImageModel(provider: ImageProviderName): string {
  if (provider === 'local') return '';
  if (provider === 'gemini') return process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  return process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
}

function envDefaultTtsProvider(): TtsProvider {
  const raw = (process.env.TTS_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

/**
 * Resolves the campaign's master-backend flag. Order: explicit stored value
 * (campaign settings) → env `MASTER_BACKEND` override → 'baked' default.
 * The env override is for ops / CI smoke testing without touching DB rows;
 * a stored value always wins. There is no user-preference layer — the field
 * is campaign-only by design (Decision 2 in PLAN.md, validated by spike 004).
 */
function envDefaultMasterBackend(): MasterBackend {
  const raw = (process.env.MASTER_BACKEND ?? '').trim().toLowerCase();
  return raw === 'vault' ? 'vault' : 'baked';
}

export function resolveMasterBackend(stored: MasterBackend | undefined): MasterBackend {
  if (stored === 'vault' || stored === 'baked') return stored;
  return envDefaultMasterBackend();
}

/**
 * Phase 03-B vault-llm-wiki — cutover semantics (Decision 4). Parallel-shape
 * with `MasterBackend` (Phase 01) and `resolveVaultMutations` (Phase 02).
 *
 * Selects which store is authoritative for snapshot READS:
 *  - 'postgres' (default) → buildClientSnapshot reads session_state + characters
 *  - 'vault'              → buildClientSnapshot materializes from events.md replay
 *
 * The resolver does NOT enforce preconditions (masterBackend === 'vault' AND
 * vaultMutations === true). Plan 03-B-02's `scripts/vault-cutover.ts` does,
 * with a clear operator error before flipping.
 */
export type SourceOfTruth = 'postgres' | 'vault';

export function isSourceOfTruth(v: unknown): v is SourceOfTruth {
  return v === 'postgres' || v === 'vault';
}

/**
 * Env override `MASTER_SOURCE_OF_TRUTH` for ops / CI smoke testing without
 * touching DB rows. A stored campaign value always wins. Defaults to
 * 'postgres' (Phase 02 behavior — backward compatible until cutover).
 */
function envDefaultSourceOfTruth(): SourceOfTruth {
  const raw = (process.env.MASTER_SOURCE_OF_TRUTH ?? '').trim().toLowerCase();
  return raw === 'vault' ? 'vault' : 'postgres';
}

export function resolveSourceOfTruth(stored: SourceOfTruth | undefined): SourceOfTruth {
  if (stored === 'postgres' || stored === 'vault') return stored;
  return envDefaultSourceOfTruth();
}

/**
 * Phase 03-A vault-llm-wiki — dual-write coexistence (Decision 2). Returns
 * true ONLY when `settings.dualWrite === true`. No env override — dual-write
 * is operator-set per campaign only; an env-wide default would risk
 * accidental global enablement of the Promise.all([vault, postgres]) fan-out.
 *
 * Orthogonal to `sourceOfTruth` (Decision 4): both flags can be true in
 * any combination. Consumed by plan 03-A-10 dispatch gate.
 */
export function resolveDualWrite(settings: { dualWrite?: boolean } | undefined): boolean {
  if (!settings) return false;
  return settings.dualWrite === true;
}

/**
 * Resolves the campaign's vault-mutations opt-in flag.
 *
 * Returns `true` ONLY when both conditions hold:
 *  - `masterBackend === 'vault'` (vault path active for this campaign)
 *  - `vaultMutations === true` (mutations explicitly enabled)
 *
 * Returns `false` in all other cases — including when `masterBackend ===
 * 'baked'` but `vaultMutations: true` is stored (Pitfall 5: orthogonal
 * flags, resolver-level enforcement so the stored value has no effect on
 * a baked campaign). The vault-flip script warns when flipping
 * `vaultMutations: true` on a baked campaign.
 *
 * Phase 02 — locked by Decision 5.
 */
export function resolveVaultMutations(
  settings: { masterBackend?: MasterBackend; vaultMutations?: boolean } | undefined,
): boolean {
  if (!settings) return false;
  const backend = resolveMasterBackend(settings.masterBackend);
  if (backend !== 'vault') return false;
  return settings.vaultMutations === true;
}

/**
 * Phase 02 plan 02-08 — stale-UI banner copy (operator approved).
 *
 * Shown on the campaign Settings page (and elsewhere stale-data warnings
 * surface) when the active campaign has vaultMutations enabled. The text
 * informs the operator that the UI continues to reflect Postgres state
 * until the next session refresh — single-write semantics from
 * Phase 02 Decision 8.
 *
 * Locked verbatim — the campaign language (Italian, matches the One Piece
 * preset). Phase 03 reconciles dual-write and will deprecate this banner.
 */
export const VAULT_MUTATIONS_STALE_UI_BANNER =
  'Vault attivo — ricarica per vedere lo stato più recente';

/** Per-provider env-overridable model default. Falls back to the static
 *  per-provider default if no env var is set. */
function envDefaultTtsModel(provider: TtsProvider): string {
  if (provider === 'gemini') {
    return process.env.GEMINI_TTS_MODEL ?? ttsModelDefault('gemini');
  }
  return process.env.OPENAI_TTS_MODEL ?? ttsModelDefault('openai');
}

/** Env-overridable default voice for a given (provider, model) pair. The
 *  model matters for OpenAI because some voices (e.g. ballad) only exist on
 *  gpt-4o-mini-tts — the legacy tts-1/tts-1-hd models reject them. */
function envDefaultTtsVoice(provider: TtsProvider, model: string): string {
  const envOverride = provider === 'gemini' ? process.env.GEMINI_TTS_VOICE : process.env.OPENAI_TTS_VOICE;
  // Honour the env override only if it's actually supported by the model in
  // play — otherwise it would force every user onto an invalid voice.
  if (envOverride && ttsVoicesForModel(provider, model).includes(envOverride)) {
    return envOverride;
  }
  return ttsVoiceDefaultForModel(provider, model);
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  ttsProvider: 'openai',
  ttsVoice: 'onyx',
  ttsModel: 'gpt-4o-mini-tts',
  ttsAutoplay: false,
  manualRolls: false,
  // These are set lazily inside getResolvedPreferences so the env values are read
  // at request time, not at module-load time.
  aiProvider: 'anthropic',
  aiMasterModel: 'claude-sonnet-4-5',
  // Default master guidance: balanced — hint at options without enumerating
  // them as a bullet list. Existing players who set their preference keep
  // their pick; new players start here.
  masterGuidanceLevel: 'balanced',
  // Default: reveal DC/AC numbers in prose (current behavior). Players who
  // want a more immersive experience can flip this off.
  showDifficultyNumbers: true,
  // Default: 'detailed' narration — every micro-beat is its own turn.
  // Players who want the master to skip obvious follow-through ("you
  // press the lever; the passage opens; you step inside") can flip to
  // 'brisk' in /settings.
  narrationPace: 'detailed',
  imageGenerationEnabled: false,
  imageStylePreset: 'pastel',
  imageStyleCustom: '',
  imageProvider: 'openai',
  imageModel: 'gpt-image-1',
  // The three optimisation toggles below are now always-on by default —
  // the dedicated "Local optimization" panel was removed from Settings to
  // declutter the UI. Existing stored values (true OR false) still win.
  compactPrompt: true,
  useModeAwarePrompt: true,
  // Phase 01 vault-llm-wiki — campaign-only flag; user-side default is
  // 'baked' for parallel-shape parity with CampaignSettings. The resolver
  // ignores this user-side value; campaign-side resolution is in
  // getCampaignSettings.
  masterBackend: 'baked',
  // Phase 02 vault-llm-wiki — per-campaign opt-in for event-sourced
  // mutations. Default false (off); orthogonal to masterBackend.
  vaultMutations: false,
  // Phase 03-B vault-llm-wiki — cutover flag; default 'postgres' so existing
  // campaigns keep reading from Postgres until the operator runs
  // scripts/vault-cutover.ts (plan 03-B-02). User-side parallel-shape only;
  // authoritative campaign-side resolution lives in getCampaignSettings via
  // resolveSourceOfTruth.
  sourceOfTruth: 'postgres',
  // Phase 03-A vault-llm-wiki — dual-write coexistence; default false (single
  // write to vault, Phase 02 behavior). Flipped per campaign by the migration
  // script (plan 03-A-07) once dual-write is ready to validate parity.
  dualWrite: false,
  // Phase 03-B audit — empty by default. Set by scripts/vault-cutover.ts
  // (plan 03-B-02) to the ISO timestamp of the most recent flip to 'vault'.
  cutoverAt: '',
};

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const [row] = await db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.preferences ?? {};
}

/** Returns prefs with defaults applied for any missing field. Env-driven defaults
 * for provider/model are resolved at call time so a redeploy with new env vars
 * affects existing users who haven't explicitly set a value. */
export async function getResolvedPreferences(userId: string): Promise<Required<UserPreferences>> {
  const prefs = await getUserPreferences(userId);
  const provider = resolveLocalAiProvider(prefs.aiProvider);
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = resolveLocalImageProvider(prefs.imageProvider);
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  // TTS triplet — provider drives the namespace; (provider, model) drives the
  // namespace for voice. Voice support is model-specific on OpenAI: 'ballad'
  // only works on gpt-4o-mini-tts and the legacy tts-1 / tts-1-hd reject it
  // with 400. Resolve model first, then voice against that model.
  const ttsProvider = resolveLocalTtsProvider(prefs.ttsProvider);
  const storedModel = prefs.ttsModel;
  const ttsModel = (() => {
    if (ttsProvider === 'local') {
      return storedModel === 'piper' ? storedModel : 'piper';
    }
    return storedModel && ttsModelsFor(ttsProvider).includes(storedModel)
      ? storedModel
      : envDefaultTtsModel(ttsProvider);
  })();
  const storedVoice = prefs.ttsVoice;
  const ttsVoice = (() => {
    if (ttsProvider === 'local') {
      // Piper voices are runtime-discovered; pass through any stored value.
      return storedVoice ?? '';
    }
    return storedVoice && ttsVoicesForModel(ttsProvider, ttsModel).includes(storedVoice)
      ? storedVoice
      : envDefaultTtsVoice(ttsProvider, ttsModel);
  })();
  // Always default to compact prompt unless the stored value says otherwise.
  // The UI toggle was removed; this is the new policy across providers.
  const compactPrompt = prefs.compactPrompt ?? true;
  const useModeAwarePrompt = resolveUseModeAwarePrompt({ aiProvider: provider, useModeAwarePrompt: prefs.useModeAwarePrompt });
  // Phase 01 vault-llm-wiki — user-side parallel shape only; resolution is
  // campaign-only at runtime (this value is never read directly).
  const masterBackend = resolveMasterBackend(prefs.masterBackend);
  return {
    ttsProvider,
    ttsVoice,
    ttsModel,
    ttsAutoplay: prefs.ttsAutoplay ?? DEFAULT_PREFERENCES.ttsAutoplay,
    manualRolls: prefs.manualRolls ?? DEFAULT_PREFERENCES.manualRolls,
    aiProvider: provider,
    aiMasterModel: masterModel,
    masterGuidanceLevel: prefs.masterGuidanceLevel ?? DEFAULT_PREFERENCES.masterGuidanceLevel,
    showDifficultyNumbers: prefs.showDifficultyNumbers ?? DEFAULT_PREFERENCES.showDifficultyNumbers,
    narrationPace: prefs.narrationPace ?? DEFAULT_PREFERENCES.narrationPace,
    imageGenerationEnabled,
    imageStylePreset,
    imageStyleCustom,
    imageProvider,
    imageModel,
    compactPrompt,
    useModeAwarePrompt,
    masterBackend,
    // Phase 02 vault-llm-wiki — user-side parallel-shape parity only;
    // authoritative campaign-side resolution lives in `getCampaignSettings`
    // via `resolveVaultMutations`. This branch is never the one consulted
    // at runtime for the apply_event gate.
    vaultMutations: prefs.vaultMutations ?? DEFAULT_PREFERENCES.vaultMutations,
    // Phase 03-B vault-llm-wiki — user-side parallel-shape only; the
    // authoritative campaign-side resolution lives in `getCampaignSettings`
    // via `resolveSourceOfTruth`. Never consulted by snapshot-reader.
    sourceOfTruth: resolveSourceOfTruth(prefs.sourceOfTruth),
    // Phase 03-A vault-llm-wiki — user-side parallel-shape only; the
    // authoritative campaign-side resolution lives in `getCampaignSettings`
    // via `resolveDualWrite`. Never consulted by the dual-write dispatch.
    dualWrite: resolveDualWrite(prefs),
    // Phase 03-B audit — user-side parallel-shape only; always empty on
    // user rows. The cutover script only writes campaign settings.
    cutoverAt: prefs.cutoverAt ?? DEFAULT_PREFERENCES.cutoverAt,
  };
}

export async function updateUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const merged: UserPreferences = { ...current, ...patch };
  await db.update(users).set({ preferences: merged }).where(eq(users.id, userId));
  return merged;
}

/**
 * Session-scoped resolved settings — proxies to the session's campaign.
 *
 * Multiplayer rule: every shared decision (provider, model, narration
 * pace, image gen, manual rolls, master guidance, difficulty visibility,
 * TTS voice/model) is owned by the campaign, editable only by the
 * creator. This helper exists so call sites that have a sessionId in
 * hand (turn endpoint, memory rebuild, scene-image, TTS) don't have to
 * look up the campaign themselves.
 *
 * Returns a shape compatible with the old `UserPreferences`-keyed
 * result: we add `ttsAutoplay: false` as a no-op so the type doesn't
 * narrow at call sites. Autoplay is per-viewer — call
 * `getResolvedPreferences(viewerId)` if you actually need it.
 *
 * Throws if the session is missing or soft-deleted (programmer error).
 */
export async function getSessionMasterPreferences(
  sessionId: string,
): Promise<Required<UserPreferences>> {
  const [row] = await db
    .select({ campaignId: sessions.campaignId })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`getSessionMasterPreferences: session ${sessionId} not found`);
  const camp = await getCampaignSettings(row.campaignId);
  return { ...camp, ttsAutoplay: false };
}

export type { CampaignSettings };

/**
 * Read raw stored settings for a campaign. Returns `{}` if the row is
 * unpopulated. Throws if the campaign is missing or soft-deleted.
 */
async function getCampaignSettingsRaw(campaignId: string): Promise<CampaignSettings> {
  const [row] = await db
    .select({ settings: campaigns.settings })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`getCampaignSettings: campaign ${campaignId} not found`);
  return row.settings ?? {};
}

/**
 * Campaign-scoped resolved settings — the authoritative source for every
 * shared decision (AI provider/model, TTS voice/model, narration pace,
 * master guidance, difficulty visibility, image generation, manual rolls).
 *
 * Defaults cascade exactly like `getResolvedPreferences`: stored value
 * (if any) → env var (if provided) → static default. Resolution happens
 * at call time so a redeploy with new env defaults flows through to
 * existing campaigns that never explicitly set a value.
 *
 * Throws on missing / soft-deleted campaign id — programmer error.
 */
export async function getCampaignSettings(
  campaignId: string,
): Promise<Required<CampaignSettings>> {
  const prefs = await getCampaignSettingsRaw(campaignId);
  const provider = resolveLocalAiProvider(prefs.aiProvider);
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = resolveLocalImageProvider(prefs.imageProvider);
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  const ttsProvider = resolveLocalTtsProvider(prefs.ttsProvider);
  const storedModel = prefs.ttsModel;
  const ttsModel = (() => {
    if (ttsProvider === 'local') {
      return storedModel === 'piper' ? storedModel : 'piper';
    }
    return storedModel && ttsModelsFor(ttsProvider).includes(storedModel)
      ? storedModel
      : envDefaultTtsModel(ttsProvider);
  })();
  const storedVoice = prefs.ttsVoice;
  const ttsVoice = (() => {
    if (ttsProvider === 'local') {
      return storedVoice ?? '';
    }
    return storedVoice && ttsVoicesForModel(ttsProvider, ttsModel).includes(storedVoice)
      ? storedVoice
      : envDefaultTtsVoice(ttsProvider, ttsModel);
  })();
  // Always default to compact prompt unless the stored value says otherwise.
  const compactPrompt = prefs.compactPrompt ?? true;
  const useModeAwarePrompt = resolveUseModeAwarePrompt({ aiProvider: provider, useModeAwarePrompt: prefs.useModeAwarePrompt });
  // Phase 01 vault-llm-wiki — authoritative campaign resolution.
  const masterBackend = resolveMasterBackend(prefs.masterBackend);
  return {
    ttsProvider,
    ttsVoice,
    ttsModel,
    manualRolls: prefs.manualRolls ?? DEFAULT_PREFERENCES.manualRolls,
    aiProvider: provider,
    aiMasterModel: masterModel,
    masterGuidanceLevel: prefs.masterGuidanceLevel ?? DEFAULT_PREFERENCES.masterGuidanceLevel,
    showDifficultyNumbers: prefs.showDifficultyNumbers ?? DEFAULT_PREFERENCES.showDifficultyNumbers,
    narrationPace: prefs.narrationPace ?? DEFAULT_PREFERENCES.narrationPace,
    imageGenerationEnabled,
    imageStylePreset,
    imageStyleCustom,
    imageProvider,
    imageModel,
    compactPrompt,
    useModeAwarePrompt,
    masterBackend,
    // Phase 02 vault-llm-wiki — authoritative campaign resolution.
    // Pitfall 5: returns false when masterBackend !== 'vault' regardless
    // of stored value, so flipping vaultMutations on a baked campaign is
    // a no-op until masterBackend is also flipped to 'vault'.
    vaultMutations: resolveVaultMutations(prefs),
    // Phase 03-B vault-llm-wiki — authoritative campaign resolution
    // (Decision 4). Defaults to 'postgres' until the operator runs the
    // cutover script (plan 03-B-02). Read by buildClientSnapshot (plan
    // 03-B-07) to decide whether to materialize from events.md or from
    // session_state + characters.
    sourceOfTruth: resolveSourceOfTruth(prefs.sourceOfTruth),
    // Phase 03-A vault-llm-wiki — authoritative campaign resolution
    // (Decision 2). Defaults to false (Phase 02 single-write path). Read
    // by the turn route (plan 03-A-10) to gate the DualWriter fan-out.
    // Orthogonal to sourceOfTruth — operator-set per campaign only.
    dualWrite: resolveDualWrite(prefs),
    // Phase 03-B audit — ISO timestamp of the most recent flip to 'vault',
    // set by scripts/vault-cutover.ts (plan 03-B-02). Falls through as the
    // stored value (empty string when never flipped) — read by the
    // cutover script's rollback-window check.
    cutoverAt: prefs.cutoverAt ?? DEFAULT_PREFERENCES.cutoverAt,
  };
}

export async function updateCampaignSettings(
  campaignId: string,
  patch: Partial<CampaignSettings>,
): Promise<CampaignSettings> {
  const current = await getCampaignSettingsRaw(campaignId);
  const merged: CampaignSettings = { ...current, ...patch };
  await db
    .update(campaigns)
    .set({ settings: merged, updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  return merged;
}

export type ValidatedSettings = Partial<CampaignSettings & { ttsAutoplay?: boolean }>;

export type ValidateResult =
  | { ok: true; patch: ValidatedSettings }
  | { ok: false; error: string };

/**
 * Shared field-by-field validation for settings patches. Accepts the full
 * superset (campaign keys + ttsAutoplay). Callers decide which keys are
 * allowed for their endpoint and pre-filter the body before calling.
 *
 * Returns the same shape as the input on success — useful so the caller
 * can persist exactly what the validator OK'd.
 */
/** Validates a settings patch.
 *
 *  `stored` is the optional current state (typically what
 *  getCampaignSettings returned). When provided, branches that depend on
 *  the resolved provider fall back to the stored provider if the patch
 *  itself doesn't carry one. Without `stored`, a patch like
 *  `{ aiMasterModel: 'qwen3:30b-a3b' }` (no aiProvider) cannot know it
 *  belongs to a 'local' campaign and the cloud-catalog check rejects it. */
export function validateSettingsPatch(
  body: ValidatedSettings,
  stored?: { aiProvider?: string; ttsProvider?: string; ttsModel?: string; imageProvider?: string },
): ValidateResult {
  const out: ValidatedSettings = {};
  if ('ttsProvider' in body) {
    if (body.ttsProvider === undefined || body.ttsProvider === null) out.ttsProvider = undefined;
    else if (!isValidTtsProvider(body.ttsProvider)) return { ok: false, error: 'invalid-ttsProvider' };
    else if (body.ttsProvider === 'local' && !isLocalSurfaceAvailable('tts')) {
      return { ok: false, error: 'invalid-ttsProvider' };
    } else out.ttsProvider = body.ttsProvider;
  }
  if ('ttsModel' in body) {
    if (body.ttsModel === undefined || body.ttsModel === null) {
      out.ttsModel = undefined;
    } else if (typeof body.ttsModel !== 'string') {
      return { ok: false, error: 'invalid-ttsModel' };
    } else {
      const resolvedProvider = out.ttsProvider ?? body.ttsProvider ?? stored?.ttsProvider;
      if (resolvedProvider === 'local') {
        if (body.ttsModel !== 'piper') {
          return { ok: false, error: 'invalid-ttsModel' };
        }
        if (!isLocalSurfaceAvailable('tts', body.ttsModel)) {
          return { ok: false, error: 'invalid-ttsModel' };
        }
      } else if (!isValidTtsModel(body.ttsModel)) {
        return { ok: false, error: 'invalid-ttsModel' };
      }
      out.ttsModel = body.ttsModel;
    }
  }
  if ('ttsVoice' in body) {
    if (body.ttsVoice === undefined || body.ttsVoice === null) {
      out.ttsVoice = undefined;
    } else if (typeof body.ttsVoice !== 'string') {
      return { ok: false, error: 'invalid-ttsVoice' };
    } else {
      const resolvedProvider = out.ttsProvider ?? body.ttsProvider ?? stored?.ttsProvider;
      // Fall back to stored.ttsModel so a voice-only PATCH (the Settings UI
      // sends just the changed field) validates against the right namespace
      // instead of dropping into the OpenAI/Gemini-only branch.
      const resolvedModel = out.ttsModel ?? body.ttsModel ?? stored?.ttsModel;
      if (resolvedProvider === 'local' && typeof resolvedModel === 'string') {
        if (!isValidVoiceForModel(body.ttsVoice, 'local', resolvedModel)) {
          return { ok: false, error: 'invalid-ttsVoice' };
        }
      } else if (!isValidTtsVoice(body.ttsVoice)) {
        return { ok: false, error: 'invalid-ttsVoice' };
      }
      out.ttsVoice = body.ttsVoice;
    }
  }
  if ('ttsAutoplay' in body) {
    if (typeof body.ttsAutoplay !== 'boolean') return { ok: false, error: 'invalid-ttsAutoplay' };
    out.ttsAutoplay = body.ttsAutoplay;
  }
  if ('manualRolls' in body) {
    if (typeof body.manualRolls !== 'boolean') return { ok: false, error: 'invalid-manualRolls' };
    out.manualRolls = body.manualRolls;
  }
  if ('aiProvider' in body) {
    if (!isKnownProvider(body.aiProvider)) return { ok: false, error: 'invalid-aiProvider' };
    if (body.aiProvider === 'local' && !isLocalSurfaceAvailable('ai')) {
      return { ok: false, error: 'invalid-aiProvider' };
    }
    out.aiProvider = body.aiProvider;
  }
  if ('aiMasterModel' in body) {
    if (body.aiMasterModel !== undefined) {
      const m = body.aiMasterModel;
      if (typeof m !== 'string' || m.length === 0 || m.length > 200) {
        return { ok: false, error: 'invalid-aiMasterModel' };
      }
      const resolvedProvider = out.aiProvider ?? body.aiProvider ?? stored?.aiProvider;
      if (resolvedProvider !== 'local' && !isKnownMasterModel(m)) {
        return { ok: false, error: 'invalid-aiMasterModel' };
      }
    }
    out.aiMasterModel = body.aiMasterModel as string | undefined;
  }
  if ('masterGuidanceLevel' in body) {
    if (!isMasterGuidanceLevel(body.masterGuidanceLevel)) return { ok: false, error: 'invalid-masterGuidanceLevel' };
    out.masterGuidanceLevel = body.masterGuidanceLevel;
  }
  if ('showDifficultyNumbers' in body) {
    if (typeof body.showDifficultyNumbers !== 'boolean') return { ok: false, error: 'invalid-showDifficultyNumbers' };
    out.showDifficultyNumbers = body.showDifficultyNumbers;
  }
  if ('narrationPace' in body) {
    if (!isNarrationPace(body.narrationPace)) return { ok: false, error: 'invalid-narrationPace' };
    out.narrationPace = body.narrationPace;
  }
  if ('imageGenerationEnabled' in body) {
    if (typeof body.imageGenerationEnabled !== 'boolean') return { ok: false, error: 'invalid-imageGenerationEnabled' };
    out.imageGenerationEnabled = body.imageGenerationEnabled;
  }
  if ('imageStylePreset' in body) {
    if (!isImageStylePreset(body.imageStylePreset)) return { ok: false, error: 'invalid-imageStylePreset' };
    out.imageStylePreset = body.imageStylePreset;
  }
  if ('imageStyleCustom' in body) {
    if (typeof body.imageStyleCustom !== 'string') return { ok: false, error: 'invalid-imageStyleCustom' };
    if (body.imageStyleCustom.length > 500) return { ok: false, error: 'imageStyleCustom-too-long' };
    out.imageStyleCustom = body.imageStyleCustom;
  }
  if ('imageProvider' in body) {
    if (!isKnownImageProvider(body.imageProvider)) return { ok: false, error: 'invalid-imageProvider' };
    if (body.imageProvider === 'local' && !isLocalSurfaceAvailable('image')) {
      return { ok: false, error: 'invalid-imageProvider' };
    }
    out.imageProvider = body.imageProvider;
  }
  if ('imageModel' in body) {
    if (body.imageModel !== undefined) {
      if (!isKnownImageModel(body.imageModel)) {
        return { ok: false, error: 'invalid-imageModel' };
      }
      const resolvedProvider = out.imageProvider ?? body.imageProvider ?? stored?.imageProvider;
      if (resolvedProvider === 'local') {
        if (!isLocalSurfaceAvailable('image', body.imageModel)) {
          return { ok: false, error: 'invalid-imageModel' };
        }
      }
    }
    out.imageModel = body.imageModel as string | undefined;
  }
  if ('compactPrompt' in body) {
    if (typeof body.compactPrompt !== 'boolean') return { ok: false, error: 'invalid-compactPrompt' };
    out.compactPrompt = body.compactPrompt;
  }
  if ('useModeAwarePrompt' in body) {
    if (typeof body.useModeAwarePrompt !== 'boolean') return { ok: false, error: 'invalid-useModeAwarePrompt' };
    out.useModeAwarePrompt = body.useModeAwarePrompt;
  }
  if ('masterBackend' in body) {
    if (body.masterBackend === undefined || body.masterBackend === null) {
      out.masterBackend = undefined;
    } else if (!isMasterBackend(body.masterBackend)) {
      return { ok: false, error: 'invalid-masterBackend' };
    } else {
      out.masterBackend = body.masterBackend;
    }
  }
  // Phase 02 vault-llm-wiki — boolean opt-in stored alongside masterBackend.
  // The validator only sanity-checks the shape; the runtime gate is in
  // `resolveVaultMutations` (Pitfall 5: false when masterBackend !== 'vault').
  if ('vaultMutations' in body) {
    if (body.vaultMutations === undefined || body.vaultMutations === null) {
      out.vaultMutations = undefined;
    } else if (typeof body.vaultMutations !== 'boolean') {
      return { ok: false, error: 'invalid-vaultMutations' };
    } else {
      out.vaultMutations = body.vaultMutations;
    }
  }
  // Phase 03-B vault-llm-wiki — cutover semantics (Decision 4). Shape check
  // only; the cutover precondition (masterBackend === 'vault' AND
  // vaultMutations === true) is enforced by scripts/vault-cutover.ts.
  if ('sourceOfTruth' in body) {
    if (body.sourceOfTruth === undefined || body.sourceOfTruth === null) {
      out.sourceOfTruth = undefined;
    } else if (!isSourceOfTruth(body.sourceOfTruth)) {
      return { ok: false, error: 'invalid-sourceOfTruth' };
    } else {
      out.sourceOfTruth = body.sourceOfTruth;
    }
  }
  // Phase 03-A vault-llm-wiki — boolean dual-write opt-in. Shape check only;
  // the runtime gate is in `resolveDualWrite`.
  if ('dualWrite' in body) {
    if (body.dualWrite === undefined || body.dualWrite === null) {
      out.dualWrite = undefined;
    } else if (typeof body.dualWrite !== 'boolean') {
      return { ok: false, error: 'invalid-dualWrite' };
    } else {
      out.dualWrite = body.dualWrite;
    }
  }
  // Phase 03-B audit — ISO timestamp set by scripts/vault-cutover.ts. The
  // validator rejects non-ISO strings so the cutover script gets a clean
  // input contract. Date.parse handles the full ISO-8601 set.
  if ('cutoverAt' in body) {
    if (body.cutoverAt === undefined || body.cutoverAt === null) {
      out.cutoverAt = undefined;
    } else if (typeof body.cutoverAt !== 'string' || isNaN(Date.parse(body.cutoverAt))) {
      return { ok: false, error: 'invalid-cutoverAt' };
    } else {
      out.cutoverAt = body.cutoverAt;
    }
  }
  return { ok: true, patch: out };
}

/**
 * Resolves the effective `useModeAwarePrompt` value. An explicit stored
 * boolean always wins. The UI toggle was removed; the new default is ON
 * across providers.
 */
export function resolveUseModeAwarePrompt(prefs: {
  aiProvider: string;
  useModeAwarePrompt?: boolean;
}): boolean {
  if (typeof prefs.useModeAwarePrompt === 'boolean') return prefs.useModeAwarePrompt;
  return true;
}

