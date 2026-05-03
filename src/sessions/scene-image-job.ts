import OpenAI from 'openai';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';
import { buildImagePrompt } from '@/ai/master/image-style';

let _client: OpenAI | null = null;
let _override: OpenAI | null = null;

function client(): OpenAI {
  if (_override) return _override;
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  _client = new OpenAI({ apiKey });
  return _client;
}

/** Test-only seam — let unit tests inject a mocked OpenAI instance. */
export function __setOpenAIClientForTest(mock: OpenAI | null): void {
  _override = mock;
}

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';

export type GenerateResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'empty_response' | 'race_lost' | 'api_error'; detail?: string };

/**
 * Generate an illustration from a visual prompt and persist the bytes onto
 * `session_state` if the row is still at `expectedVersion - 1` (race-safe
 * conditional UPDATE).
 *
 * Returns a structured result so callers (currently the manual-button
 * endpoint) can surface success/failure to the user. Errors are caught and
 * never thrown — the row stays untouched on failure.
 */
export async function generateAndPersist(
  sessionId: string,
  visualPrompt: string,
  styleText: string,
  expectedVersion: number,
): Promise<GenerateResult> {
  const fullPrompt = buildImagePrompt(visualPrompt, styleText);
  let bytes: Buffer;
  try {
    const res = await client().images.generate({
      model: IMAGE_MODEL,
      prompt: fullPrompt,
      size: '1024x1024',
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) {
      console.warn('[scene-image] empty response from image API', { sessionId });
      return { ok: false, reason: 'empty_response' };
    }
    bytes = Buffer.from(b64, 'base64');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[scene-image] generation failed', { sessionId, error: detail });
    return { ok: false, reason: 'api_error', detail };
  }

  const updated = await db.update(sessionState)
    .set({
      sceneImageData: bytes,
      sceneImagePrompt: visualPrompt,
      sceneImageVersion: expectedVersion,
    })
    .where(and(
      eq(sessionState.sessionId, sessionId),
      eq(sessionState.sceneImageVersion, expectedVersion - 1),
    ));

  // pg driver exposes rowCount on the result; if 0, our expectedVersion was
  // stale (a concurrent writer moved the row). The caller can decide
  // whether to retry.
  if ((updated.rowCount ?? 0) === 0) {
    return { ok: false, reason: 'race_lost' };
  }
  return { ok: true, version: expectedVersion };
}
