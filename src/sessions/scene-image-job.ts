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

/**
 * Background image job. Runs OUTSIDE the applicator transaction (the
 * caller wraps this in waitUntil). On success, writes the PNG bytes and
 * the bumped version conditionally — the WHERE guards against racing
 * jobs writing stale state.
 *
 * Failures are intentionally silent: any thrown error means the
 * version stays at expectedVersion - 1 and the panel keeps showing the
 * previous image. The caller has no recourse and the player has
 * already moved on.
 */
export async function generateAndPersist(
  sessionId: string,
  visualPrompt: string,
  styleText: string,
  expectedVersion: number,
): Promise<void> {
  const fullPrompt = buildImagePrompt(visualPrompt, styleText);
  try {
    const res = await client().images.generate({
      model: IMAGE_MODEL,
      prompt: fullPrompt,
      size: '1024x1024',
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) {
      console.warn('[scene-image] empty response from image API', { sessionId });
      return;
    }
    const bytes = Buffer.from(b64, 'base64');

    await db.update(sessionState)
      .set({
        sceneImageData: bytes,
        sceneImagePrompt: visualPrompt,
        sceneImageVersion: expectedVersion,
      })
      .where(and(
        eq(sessionState.sessionId, sessionId),
        eq(sessionState.sceneImageVersion, expectedVersion - 1),
      ));
  } catch (e) {
    console.error('[scene-image] generation failed', { sessionId, error: e instanceof Error ? e.message : String(e) });
    // Silent fail: version stays put, panel keeps last image.
  }
}
