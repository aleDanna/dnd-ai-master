import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageGenResult } from './openai';

const WORKFLOWS_DIR = join(process.cwd(), 'src/sessions/image-providers/comfyui-workflows');
const POLL_INTERVAL_MS = 1_000;
const MAX_WAIT_MS = 60_000;

/** Loads a ComfyUI workflow JSON template by slug. The slug is sanitized to
 *  alphanumeric+dash before joining the path (defensive). */
export async function loadWorkflowTemplate(name: string): Promise<string> {
  const safe = name.replace(/[^a-z0-9-]/gi, '');
  if (!safe) throw new Error(`comfyui: invalid workflow name "${name}"`);
  try {
    return await readFile(join(WORKFLOWS_DIR, `${safe}.json`), 'utf8');
  } catch (e) {
    throw new Error(`comfyui: workflow "${safe}" not found (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Escapes a string for safe insertion into a JSON document via string
 *  replace — quotes and backslashes need escaping. */
export function escapeJsonString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

interface ComfyHistory {
  [promptId: string]: {
    status?: { completed?: boolean };
    outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Submits a prompt to ComfyUI, polls /history until completion, then fetches
 *  the produced PNG via /view. Returns the codebase-standard ImageGenResult. */
export async function generateBytesComfyUI(prompt: string, workflowSlug: string): Promise<ImageGenResult> {
  const base = process.env.COMFYUI_BASE_URL;
  if (!base) return { ok: false, reason: 'api_error', detail: 'COMFYUI_BASE_URL is not set' };
  try {
    const workflowName = workflowSlug || process.env.COMFYUI_FLUX_WORKFLOW || 'flux-schnell';
    const template = await loadWorkflowTemplate(workflowName);
    const workflow = JSON.parse(template.replace('{{PROMPT}}', escapeJsonString(prompt)));

    const submitRes = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    });
    if (!submitRes.ok) {
      return { ok: false, reason: 'api_error', detail: `submit ${submitRes.status}` };
    }
    const { prompt_id } = (await submitRes.json()) as { prompt_id: string };

    const startTime = Date.now();
    while (Date.now() - startTime < MAX_WAIT_MS) {
      const histRes = await fetch(`${base}/history/${prompt_id}`);
      if (histRes.ok) {
        const hist = (await histRes.json()) as ComfyHistory;
        const entry = hist[prompt_id];
        if (entry?.status?.completed) {
          const image = entry.outputs?.['9']?.images?.[0];
          if (!image) return { ok: false, reason: 'empty_response' };
          const viewRes = await fetch(
            `${base}/view?filename=${encodeURIComponent(image.filename)}` +
            `&subfolder=${encodeURIComponent(image.subfolder ?? '')}&type=${encodeURIComponent(image.type ?? 'output')}`
          );
          if (!viewRes.ok) {
            return { ok: false, reason: 'api_error', detail: `view ${viewRes.status}` };
          }
          return { ok: true, bytes: Buffer.from(await viewRes.arrayBuffer()) };
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return { ok: false, reason: 'api_error', detail: 'comfyui: 60s timeout' };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
