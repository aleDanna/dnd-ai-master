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
