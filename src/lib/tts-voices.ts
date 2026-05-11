/**
 * Browser-safe TTS provider / voice / model constants. Both server and client
 * import this file because it has zero runtime dependencies on `pg` or other
 * Node-only modules.
 *
 * NOTE: Anthropic has no TTS endpoint (Claude is text-only on the platform),
 * so the TTS provider list is just OpenAI + Gemini. The master-narration
 * provider (`aiProvider` in user prefs) is independent: a user can have
 * Anthropic as the master and Gemini for the voice.
 */

export const TTS_PROVIDERS = ['openai', 'gemini'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export function isValidTtsProvider(value: unknown): value is TtsProvider {
  return typeof value === 'string' && (TTS_PROVIDERS as readonly string[]).includes(value);
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

/** Full set of OpenAI TTS voices across all models. Individual models support
 *  a subset — see OPENAI_VOICES_BY_MODEL for the precise mapping. */
export const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
] as const;
export type OpenAITtsVoice = (typeof OPENAI_TTS_VOICES)[number];

/** OpenAI text-to-speech models we expose in the settings UI.
 *  - gpt-4o-mini-tts: newest, supports instruction-style voice steering, mid latency
 *  - tts-1:           lower latency, slightly less natural prosody
 *  - tts-1-hd:        higher fidelity at the cost of latency + price */
export const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;
export type OpenAITtsModel = (typeof OPENAI_TTS_MODELS)[number];

/**
 * Per-model voice support for OpenAI. NOT every voice works with every model.
 * The legacy tts-1 / tts-1-hd models predate the gpt-4o-mini-tts release and
 * never gained the `ballad` voice — passing it returns 400 INVALID_ENUM.
 *
 * Source: OpenAI's audio.speech.create API reference, voice enum per model.
 */
export const OPENAI_VOICES_BY_MODEL: Record<OpenAITtsModel, readonly string[]> = {
  'gpt-4o-mini-tts': OPENAI_TTS_VOICES,                                          // all 10
  'tts-1':           ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],   // 9 — no ballad
  'tts-1-hd':        ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],   // 9 — no ballad
};

// ── Gemini ─────────────────────────────────────────────────────────────────

/**
 * Gemini prebuilt voice names (from Google's TTS docs). The full set of 30
 * voices exposed by the Gemini 2.5 TTS preview models. Names are case-sensitive
 * and are passed verbatim as `prebuiltVoiceConfig.voiceName`.
 */
export const GEMINI_TTS_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;
export type GeminiTtsVoice = (typeof GEMINI_TTS_VOICES)[number];

/** Gemini 2.5 TTS preview models. Both return 24kHz mono PCM that we wrap as WAV.
 *  - flash:  faster, cheaper, single-speaker oriented
 *  - pro:    higher fidelity, slower */
export const GEMINI_TTS_MODELS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
] as const;
export type GeminiTtsModel = (typeof GEMINI_TTS_MODELS)[number];

// ── Unions (used by the preferences API for shape validation) ──────────────

export const TTS_VOICES = [...OPENAI_TTS_VOICES, ...GEMINI_TTS_VOICES] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export const TTS_MODELS = [...OPENAI_TTS_MODELS, ...GEMINI_TTS_MODELS] as const;
export type TtsModel = (typeof TTS_MODELS)[number];

export function isValidTtsVoice(value: unknown): value is TtsVoice {
  return typeof value === 'string' && (TTS_VOICES as readonly string[]).includes(value);
}

export function isValidTtsModel(value: unknown): value is TtsModel {
  return typeof value === 'string' && (TTS_MODELS as readonly string[]).includes(value);
}

// ── Per-provider lookups ───────────────────────────────────────────────────

export function voicesForProvider(provider: TtsProvider): readonly string[] {
  return provider === 'gemini' ? GEMINI_TTS_VOICES : OPENAI_TTS_VOICES;
}

/** Per-model voice list. Use this for UI dropdowns and validation — the
 *  per-provider list is too lenient for OpenAI (ballad doesn't work on tts-1). */
export function voicesForModel(provider: TtsProvider, model: string): readonly string[] {
  if (provider === 'gemini') return GEMINI_TTS_VOICES;
  if (model in OPENAI_VOICES_BY_MODEL) return OPENAI_VOICES_BY_MODEL[model as OpenAITtsModel];
  return OPENAI_TTS_VOICES;
}

export function modelsForProvider(provider: TtsProvider): readonly string[] {
  return provider === 'gemini' ? GEMINI_TTS_MODELS : OPENAI_TTS_MODELS;
}

/** Default voice slug for a given provider. Picked for narration quality —
 *  'onyx' is supported by every OpenAI model. */
export function defaultVoiceForProvider(provider: TtsProvider): string {
  return provider === 'gemini' ? 'Kore' : 'onyx';
}

/** Default voice for a (provider, model) pair. Used when cascading after a
 *  model change leaves the stored voice unsupported by the new model. */
export function defaultVoiceForModel(provider: TtsProvider, model: string): string {
  const allowed = voicesForModel(provider, model);
  const fallback = defaultVoiceForProvider(provider);
  return allowed.includes(fallback) ? fallback : (allowed[0] ?? fallback);
}

/** Default model slug for a given provider. */
export function defaultModelForProvider(provider: TtsProvider): string {
  return provider === 'gemini' ? 'gemini-2.5-flash-preview-tts' : 'gpt-4o-mini-tts';
}

export function isValidVoiceForProvider(value: unknown, provider: TtsProvider): boolean {
  if (typeof value !== 'string') return false;
  return voicesForProvider(provider).includes(value);
}

export function isValidVoiceForModel(value: unknown, provider: TtsProvider, model: string): boolean {
  if (typeof value !== 'string') return false;
  return voicesForModel(provider, model).includes(value);
}

export function isValidModelForProvider(value: unknown, provider: TtsProvider): boolean {
  if (typeof value !== 'string') return false;
  return modelsForProvider(provider).includes(value);
}
