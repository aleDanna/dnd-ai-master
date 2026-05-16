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

export const TTS_PROVIDERS = ['openai', 'gemini', 'local'] as const;
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

// ── Local (Ollama-host TTS engines) ────────────────────────────────────────

/** Engine identifiers under the 'local' TTS provider. Voice namespace depends on
 *  the engine: Piper uses voice names (en_US-amy-low), XTTS uses ISO 639-1
 *  language codes (en, it, ...). */
export const LOCAL_TTS_MODELS = ['piper', 'xtts'] as const;
export type LocalTtsModel = (typeof LOCAL_TTS_MODELS)[number];

/** XTTSv2 supported languages (default speaker per language). The codes are
 *  passed verbatim as the `language` field of the xtts-api-server
 *  /tts_to_audio/ request body. */
export const XTTS_LANGUAGES = [
  { code: 'en',    label: 'English'    },
  { code: 'it',    label: 'Italian'    },
  { code: 'es',    label: 'Spanish'    },
  { code: 'fr',    label: 'French'     },
  { code: 'de',    label: 'German'     },
  { code: 'pt',    label: 'Portuguese' },
  { code: 'pl',    label: 'Polish'     },
  { code: 'ja',    label: 'Japanese'   },
  { code: 'zh-cn', label: 'Chinese'    },
] as const satisfies readonly { code: string; label: string }[];

export const XTTS_LANGUAGE_CODES = XTTS_LANGUAGES.map((l) => l.code) as readonly string[];

// ── Unions (used by the preferences API for shape validation) ──────────────

export const TTS_VOICES = [...OPENAI_TTS_VOICES, ...GEMINI_TTS_VOICES] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export const TTS_MODELS = [...OPENAI_TTS_MODELS, ...GEMINI_TTS_MODELS, ...LOCAL_TTS_MODELS] as const;
export type TtsModel = (typeof TTS_MODELS)[number];

export function isValidTtsVoice(value: unknown): value is TtsVoice {
  return typeof value === 'string' && (TTS_VOICES as readonly string[]).includes(value);
}

export function isValidTtsModel(value: unknown): value is TtsModel {
  return typeof value === 'string' && (TTS_MODELS as readonly string[]).includes(value);
}

// ── Per-provider lookups ───────────────────────────────────────────────────

export function voicesForProvider(provider: TtsProvider): readonly string[] {
  if (provider === 'gemini') return GEMINI_TTS_VOICES;
  if (provider === 'local') return [];  // engine-specific; use voicesForModel
  return OPENAI_TTS_VOICES;
}

/** Per-model voice list. Use this for UI dropdowns and validation — the
 *  per-provider list is too lenient for OpenAI (ballad doesn't work on tts-1).
 *  For local engines, XTTS returns its ISO language codes; Piper returns []
 *  (voices are runtime-discovered from PIPER_BASE_URL/v1/audio/voices). */
export function voicesForModel(provider: TtsProvider, model: string): readonly string[] {
  if (provider === 'gemini') return GEMINI_TTS_VOICES;
  if (provider === 'local') {
    if (model === 'xtts')  return XTTS_LANGUAGE_CODES;
    if (model === 'piper') return [];
    return [];
  }
  if (model in OPENAI_VOICES_BY_MODEL) return OPENAI_VOICES_BY_MODEL[model as OpenAITtsModel];
  return OPENAI_TTS_VOICES;
}

export function modelsForProvider(provider: TtsProvider): readonly string[] {
  if (provider === 'gemini') return GEMINI_TTS_MODELS;
  if (provider === 'local') return LOCAL_TTS_MODELS;
  return OPENAI_TTS_MODELS;
}

/** Default voice slug for a given provider. Picked for narration quality —
 *  'onyx' is supported by every OpenAI model. */
export function defaultVoiceForProvider(provider: TtsProvider): string {
  if (provider === 'gemini') return 'Kore';
  if (provider === 'local') return '';  // engine-specific; use defaultVoiceForModel
  return 'onyx';
}

/** Default voice for a (provider, model) pair. Used when cascading after a
 *  model change leaves the stored voice unsupported by the new model. */
export function defaultVoiceForModel(provider: TtsProvider, model: string): string {
  if (provider === 'local') {
    if (model === 'xtts') return 'en';
    return '';  // piper: runtime-discovered, UI picks first available
  }
  const allowed = voicesForModel(provider, model);
  const fallback = defaultVoiceForProvider(provider);
  return allowed.includes(fallback) ? fallback : (allowed[0] ?? fallback);
}

/** Default model slug for a given provider. */
export function defaultModelForProvider(provider: TtsProvider): string {
  if (provider === 'gemini') return 'gemini-2.5-flash-preview-tts';
  if (provider === 'local') return 'piper';
  return 'gpt-4o-mini-tts';
}

export function isValidVoiceForProvider(value: unknown, provider: TtsProvider): boolean {
  if (typeof value !== 'string') return false;
  if (provider === 'local') return value.length > 0 && value.length <= 200;
  return voicesForProvider(provider).includes(value);
}

export function isValidVoiceForModel(value: unknown, provider: TtsProvider, model: string): boolean {
  if (typeof value !== 'string') return false;
  if (provider === 'local') {
    if (model === 'xtts')  return XTTS_LANGUAGE_CODES.includes(value);
    if (model === 'piper') return value.length > 0 && value.length <= 200;
    return false;
  }
  return voicesForModel(provider, model).includes(value);
}

export function isValidModelForProvider(value: unknown, provider: TtsProvider): boolean {
  if (typeof value !== 'string') return false;
  return modelsForProvider(provider).includes(value);
}
