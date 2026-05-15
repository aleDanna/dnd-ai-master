import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessionState } from '@/db/schema';
import { buildImagePrompt } from '@/ai/master/image-style';
import { generateBytesOpenAI, __setOpenAIClientForTest } from './image-providers/openai';
import { generateBytesGemini, __setGeminiClientForTest } from './image-providers/gemini';
import { generateBytesComfyUI } from './image-providers/comfyui';
import { generateBytesDrawThings } from './image-providers/draw-things';
import type { ImageProviderName } from '@/lib/ai-models';

export { __setOpenAIClientForTest, __setGeminiClientForTest };

export type ImageProvider = 'openai' | 'gemini' | 'local';

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
  provider: ImageProviderName = 'openai',
  model?: string,
  characterAppearance?: string,
): Promise<GenerateResult> {
  const fullPrompt = buildImagePrompt(visualPrompt, styleText, characterAppearance);
  let result;
  if (provider === 'local') {
    const m = model ?? '';
    if (m.startsWith('comfyui:')) {
      result = await generateBytesComfyUI(fullPrompt, m.slice('comfyui:'.length));
    } else if (m.startsWith('draw-things:')) {
      result = await generateBytesDrawThings(fullPrompt, m.slice('draw-things:'.length));
    } else {
      result = { ok: false as const, reason: 'api_error' as const, detail: `unknown local engine in model "${m}"` };
    }
  } else if (provider === 'gemini') {
    result = await generateBytesGemini(fullPrompt, model);
  } else {
    result = await generateBytesOpenAI(fullPrompt, model);
  }

  if (!result.ok) {
    if (result.reason === 'api_error') {
      console.error('[scene-image] generation failed', { sessionId, provider, detail: result.detail });
      return { ok: false, reason: 'api_error', detail: result.detail };
    }
    console.warn('[scene-image] empty response from image API', { sessionId, provider });
    return { ok: false, reason: 'empty_response' };
  }

  const updated = await db.update(sessionState)
    .set({
      sceneImageData: result.bytes,
      sceneImagePrompt: visualPrompt,
      sceneImageVersion: expectedVersion,
    })
    .where(and(
      eq(sessionState.sessionId, sessionId),
      eq(sessionState.sceneImageVersion, expectedVersion - 1),
    ));

  if ((updated.rowCount ?? 0) === 0) {
    return { ok: false, reason: 'race_lost' };
  }
  return { ok: true, version: expectedVersion };
}
