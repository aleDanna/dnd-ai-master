import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { TtsProvider } from '@/lib/tts-voices';

/**
 * Multi-provider TTS (text-to-speech). Anthropic is intentionally absent —
 * the Anthropic platform has no audio synthesis endpoint, so the supported
 * vendors are OpenAI and Gemini. The caller picks which one via the user
 * preference (`ttsProvider`); the master-narration `aiProvider` is independent.
 *
 * Output normalization: OpenAI returns audio/mpeg directly. Gemini returns
 * 24kHz mono PCM (audio/L16) which we wrap in a WAV container server-side so
 * the cache and the browser <audio> element can treat both shapes uniformly.
 *
 * Env overrides (per-provider, used as defaults when the user hasn't picked):
 *   OPENAI_TTS_MODEL  default 'gpt-4o-mini-tts'
 *   OPENAI_TTS_VOICE  default 'onyx'
 *   GEMINI_TTS_MODEL  default 'gemini-2.5-flash-preview-tts'
 *   GEMINI_TTS_VOICE  default 'Kore'
 */

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE ?? 'onyx') as
  | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'onyx' | 'nova' | 'sage' | 'shimmer';
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE ?? 'Kore';

let _openaiClient: OpenAI | null = null;
function getOpenAIClient(): OpenAI {
  if (_openaiClient) return _openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _openaiClient = new OpenAI({ apiKey });
  return _openaiClient;
}

let _geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (_geminiClient) return _geminiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _geminiClient = new GoogleGenAI({ apiKey });
  return _geminiClient;
}

export interface SynthesizeInput {
  text: string;
  /** Which vendor to call. Defaults to 'openai' for backward compatibility. */
  provider?: TtsProvider;
  /** Voice slug. Namespace depends on `provider`. */
  voice?: string;
  /** Model slug. Namespace depends on `provider`. */
  model?: string;
}

export interface SynthesizeOutput {
  /** Raw audio bytes ready to be served (or stored verbatim) as `mimeType`. */
  bytes: ArrayBuffer;
  /** Content-Type to forward to the browser and stamp on the cache row. */
  mimeType: string;
}

/** Returns audio bytes synthesized by the chosen provider. Throws on quota /
 *  API errors so the caller can surface upstream status codes. */
export async function synthesizeSpeech(input: SynthesizeInput): Promise<SynthesizeOutput> {
  if (!input.text.trim()) throw new Error('tts: empty input');
  const provider = input.provider ?? 'openai';
  if (provider === 'gemini') return synthesizeGemini(input);
  return synthesizeOpenAI(input);
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

async function synthesizeOpenAI(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const client = getOpenAIClient();
  const response = await client.audio.speech.create({
    model: input.model ?? OPENAI_TTS_MODEL,
    voice: (input.voice ?? OPENAI_TTS_VOICE) as typeof OPENAI_TTS_VOICE,
    input: input.text,
    response_format: 'mp3',
  });
  return { bytes: await response.arrayBuffer(), mimeType: 'audio/mpeg' };
}

// ── Gemini ─────────────────────────────────────────────────────────────────

interface InlineDataPart { inlineData?: { mimeType?: string; data?: string } }

async function synthesizeGemini(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const client = getGeminiClient();
  const model = input.model ?? GEMINI_TTS_MODEL;
  const voiceName = input.voice ?? GEMINI_TTS_VOICE;

  // The TTS preview models are accessed via the same generateContent endpoint
  // as text gen, with responseModalities=['AUDIO'] + speechConfig. The SDK
  // typings don't expose speechConfig at the time of writing, so we cast.
  const res = (await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: input.text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    } as unknown as Parameters<typeof client.models.generateContent>[0]['config'],
  })) as { candidates?: { content?: { parts?: InlineDataPart[] } }[] };

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error('tts: Gemini returned no audio');

  // mimeType is e.g. "audio/L16;rate=24000" — parse rate, fall back to 24kHz.
  const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? '');
  const sampleRate = rateMatch ? parseInt(rateMatch[1]!, 10) : 24000;
  const pcm = Buffer.from(inline.data, 'base64');
  const wav = pcmToWav(pcm, sampleRate);
  // Return a fresh ArrayBuffer slice so callers can't mutate the underlying
  // Buffer pool. Casting through unknown because Node Buffer is a Uint8Array.
  const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  return { bytes: ab, mimeType: 'audio/wav' };
}

/**
 * Wrap raw 16-bit signed PCM mono samples in a minimal WAV container.
 * Browsers play this back natively via the <audio> element, and storing it
 * verbatim in the cache means we don't need to re-wrap on every replay.
 */
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM sub-chunk size
  view.setUint16(20, 1, true);           // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
