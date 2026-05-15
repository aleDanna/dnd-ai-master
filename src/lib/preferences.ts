import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, users, campaigns, type UserPreferences, isMasterGuidanceLevel, isImageStylePreset, isNarrationPace, type CampaignSettings } from '@/db/schema';
import { isKnownProvider, isKnownMasterModel, isKnownImageProvider, isKnownImageModel } from '@/lib/ai-models';

export type { UserPreferences };
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
  type TtsProvider,
} from './tts-voices';

/**
 * Defaults are merged on top of stored prefs at read time. Provider/model defaults
 * cascade from env vars when user hasn't picked anything; if env is also unset,
 * fall back to anthropic + claude-sonnet-4-5 (the historical default).
 */
function envDefaultProvider(): 'anthropic' | 'openai' | 'gemini' {
  const raw = (process.env.MASTER_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'gemini') return 'gemini';
  return 'anthropic';
}

function envDefaultMasterModel(provider: 'anthropic' | 'openai' | 'gemini'): string {
  if (provider === 'openai') return process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
  if (provider === 'gemini') return process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
  return process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
}

function envDefaultImageProvider(): 'openai' | 'gemini' {
  const raw = (process.env.IMAGE_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

function envDefaultImageModel(provider: 'openai' | 'gemini'): string {
  if (provider === 'gemini') return process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  return process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
}

function envDefaultTtsProvider(): TtsProvider {
  const raw = (process.env.TTS_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

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
  const envProvider = envDefaultProvider();
  const provider = prefs.aiProvider ?? envProvider;
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = prefs.imageProvider ?? envDefaultImageProvider();
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  // TTS triplet — provider drives the namespace; (provider, model) drives the
  // namespace for voice. Voice support is model-specific on OpenAI: 'ballad'
  // only works on gpt-4o-mini-tts and the legacy tts-1 / tts-1-hd reject it
  // with 400. Resolve model first, then voice against that model.
  const ttsProvider = prefs.ttsProvider ?? envDefaultTtsProvider();
  const storedModel = prefs.ttsModel;
  const ttsModel =
    storedModel && ttsModelsFor(ttsProvider).includes(storedModel)
      ? storedModel
      : envDefaultTtsModel(ttsProvider);
  const storedVoice = prefs.ttsVoice;
  const ttsVoice =
    storedVoice && ttsVoicesForModel(ttsProvider, ttsModel).includes(storedVoice)
      ? storedVoice
      : envDefaultTtsVoice(ttsProvider, ttsModel);
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
  const envProvider = envDefaultProvider();
  const provider = prefs.aiProvider ?? envProvider;
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = prefs.imageProvider ?? envDefaultImageProvider();
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  const ttsProvider = prefs.ttsProvider ?? envDefaultTtsProvider();
  const storedModel = prefs.ttsModel;
  const ttsModel =
    storedModel && ttsModelsFor(ttsProvider).includes(storedModel)
      ? storedModel
      : envDefaultTtsModel(ttsProvider);
  const storedVoice = prefs.ttsVoice;
  const ttsVoice =
    storedVoice && ttsVoicesForModel(ttsProvider, ttsModel).includes(storedVoice)
      ? storedVoice
      : envDefaultTtsVoice(ttsProvider, ttsModel);
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
export function validateSettingsPatch(body: ValidatedSettings): ValidateResult {
  const out: ValidatedSettings = {};
  if ('ttsProvider' in body) {
    if (body.ttsProvider === undefined || body.ttsProvider === null) out.ttsProvider = undefined;
    else if (!isValidTtsProvider(body.ttsProvider)) return { ok: false, error: 'invalid-ttsProvider' };
    else out.ttsProvider = body.ttsProvider;
  }
  if ('ttsVoice' in body) {
    if (body.ttsVoice === undefined || body.ttsVoice === null) out.ttsVoice = undefined;
    else if (!isValidTtsVoice(body.ttsVoice)) return { ok: false, error: 'invalid-ttsVoice' };
    else out.ttsVoice = body.ttsVoice;
  }
  if ('ttsModel' in body) {
    if (body.ttsModel === undefined || body.ttsModel === null) out.ttsModel = undefined;
    else if (!isValidTtsModel(body.ttsModel)) return { ok: false, error: 'invalid-ttsModel' };
    else out.ttsModel = body.ttsModel;
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
    out.aiProvider = body.aiProvider;
  }
  if ('aiMasterModel' in body) {
    if (body.aiMasterModel !== undefined && !isKnownMasterModel(body.aiMasterModel)) {
      return { ok: false, error: 'invalid-aiMasterModel' };
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
    out.imageProvider = body.imageProvider;
  }
  if ('imageModel' in body) {
    if (body.imageModel !== undefined && !isKnownImageModel(body.imageModel)) {
      return { ok: false, error: 'invalid-imageModel' };
    }
    out.imageModel = body.imageModel as string | undefined;
  }
  return { ok: true, patch: out };
}

