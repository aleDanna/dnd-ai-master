import OpenAI from 'openai';

/**
 * TTS (text-to-speech) synthesis. Always uses OpenAI regardless of MASTER_PROVIDER —
 * Anthropic does not expose a native TTS endpoint. Defaults are tuned for the
 * narrative-DM use case (deep, story-friendly voice).
 *
 * Override via env:
 *   OPENAI_TTS_MODEL   default 'gpt-4o-mini-tts'
 *   OPENAI_TTS_VOICE   default 'onyx'
 */

const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
const TTS_VOICE = (process.env.OPENAI_TTS_VOICE ?? 'onyx') as
  | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'onyx' | 'nova' | 'sage' | 'shimmer';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

export interface SynthesizeInput {
  text: string;
  /** Optional voice override (defaults to env / 'onyx'). */
  voice?: string;
  /** Optional model override (defaults to env / 'gpt-4o-mini-tts'). */
  model?: string;
}

/** Returns audio/mpeg bytes synthesized by OpenAI TTS. Throws on quota / API errors. */
export async function synthesizeSpeech(input: SynthesizeInput): Promise<ArrayBuffer> {
  if (!input.text.trim()) throw new Error('tts: empty input');
  const client = getClient();
  const response = await client.audio.speech.create({
    model: input.model ?? TTS_MODEL,
    voice: (input.voice ?? TTS_VOICE) as typeof TTS_VOICE,
    input: input.text,
    response_format: 'mp3',
  });
  return await response.arrayBuffer();
}
