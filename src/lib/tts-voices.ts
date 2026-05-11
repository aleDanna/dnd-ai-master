/**
 * Browser-safe TTS voice constants. Both server and client can import this file
 * because it has zero runtime dependencies on `pg` or other Node-only modules.
 */

export const TTS_VOICES = [
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
export type TtsVoice = (typeof TTS_VOICES)[number];

export function isValidTtsVoice(value: unknown): value is TtsVoice {
  return typeof value === 'string' && (TTS_VOICES as readonly string[]).includes(value);
}

/** OpenAI text-to-speech models we expose in the settings UI.
 *  - gpt-4o-mini-tts: newest, supports instruction-style voice steering, mid latency
 *  - tts-1:           lower latency, slightly less natural prosody
 *  - tts-1-hd:        higher fidelity at the cost of latency + price */
export const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;
export type TtsModel = (typeof TTS_MODELS)[number];

export function isValidTtsModel(value: unknown): value is TtsModel {
  return typeof value === 'string' && (TTS_MODELS as readonly string[]).includes(value);
}
