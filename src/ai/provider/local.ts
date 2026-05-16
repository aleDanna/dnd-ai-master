import { createHash } from 'node:crypto';
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import {
  anthropicSystemToOllamaMessage,
  anthropicMessagesToOllama,
  anthropicToolToOllama,
  ollamaResponseToContentBlocks,
  ollamaDoneReasonToStopReason,
  normalizeOllamaUsage,
  type OllamaMessage,
  type OllamaResponseMessage,
} from './ollama-adapter';
import { recordUsage } from '@/ai/master/usage';

const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '5m';
// Ollama defaults `num_ctx` to 2048 which truncates the master prompt
// (system + 18 tool defs + history is typically 30-45k tokens). Set high
// enough to FIT the full prompt without truncation — otherwise the KV
// prefix cache misses on every turn because Ollama's sliding-window
// truncation shifts the effective prefix between requests.
// Both qwen3:30b-a3b and gpt-oss:20b support 128k context natively.
// Cost: each extra 8k of num_ctx allocates ~2-4GB of KV cache RAM (model
// dependent). User can lower via OLLAMA_NUM_CTX if RAM-bound.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? '65536');

/**
 * "Thinking models" (qwen3, deepseek-r1, etc.) emit a separate `thinking`
 * field instead of putting content in `message.content`. When the loop sees
 * an empty content + tool_calls absent, it has nothing to render. We disable
 * thinking mode at the API level for models we know carry it, so they emit
 * actual content directly. `think: false` is a top-level Ollama option (not
 * inside `options`); models that don't recognize it ignore it silently.
 */
function isThinkingModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return m.startsWith('qwen3') || m.includes('/qwen3')
    || m.startsWith('deepseek-r1')
    || m.startsWith('gpt-oss') || m.includes('/gpt-oss');
}

/** qwen3 responds to a `/no_think` control token in the user message — BUT
 *  only when the request has no tools. With tools present qwen3 silently
 *  ignores the marker and still produces a chain-of-thought (which it parks
 *  in the `thinking` field, leaving content empty and the tool loop with
 *  nothing to render). Since we always include tools on master turns and on
 *  wizard proposals, /no_think is a no-op for our use case — keep the
 *  thinking phase, then strip the `<think>…</think>` envelope at the
 *  adapter layer (stripThinkingFromContent in ollama-adapter.ts).
 *
 *  Kept as a stub so the call sites stay symmetric; can re-enable selectively
 *  for tool-less calls later (e.g. detectLanguage already skips it). */
function prependNoThinkIfQwen3(messages: OllamaMessage[], _model: string | undefined): OllamaMessage[] {
  return messages;
}

const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

function baseUrl(): string {
  const url = process.env.OLLAMA_BASE_URL;
  if (!url) throw new Error('OLLAMA_BASE_URL is not set');
  return url;
}

interface OllamaChatResponse {
  message: OllamaResponseMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
}

function fingerprintSystem(body: unknown): string {
  try {
    const b = body as { messages?: { role: string; content: string }[] };
    const sys = b.messages?.find((m) => m.role === 'system')?.content ?? '';
    const h = createHash('md5').update(sys).digest('hex').slice(0, 8);
    return `len=${sys.length} h=${h}`;
  } catch {
    return 'n/a';
  }
}

async function chat(body: unknown): Promise<OllamaChatResponse> {
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log('[ollama-start]', `sys[${fingerprintSystem(body)}]`,
    `tools=${(body as { tools?: unknown[] }).tools?.length ?? 0}`,
    `msgs=${(body as { messages?: unknown[] }).messages?.length ?? 0}`);
  // Explicit 5-min timeout on the fetch — without this Node's default is
  // infinite and a hung Ollama would deadlock the tool loop silently
  // (the TURN_TIMEOUT_MS check upstream only runs between iterations).
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama chat ${res.status}: ${text}`);
  }
  const json = await res.json() as OllamaChatResponse;
  const promptMs = Math.round((json.prompt_eval_duration ?? 0) / 1_000_000);
  const evalMs = Math.round((json.eval_duration ?? 0) / 1_000_000);
  const loadMs = Math.round((json.load_duration ?? 0) / 1_000_000);
  const tokPerSec = json.eval_count && evalMs > 0 ? Math.round((json.eval_count / evalMs) * 1000) : 0;
  // eslint-disable-next-line no-console
  console.log('[ollama]', `${Date.now() - t0}ms`,
    'done_reason=', json.done_reason,
    'content.len=', json.message?.content?.length ?? 0,
    'tool_calls=', json.message?.tool_calls?.length ?? 0,
    `prompt(tok=${json.prompt_eval_count} ms=${promptMs})`,
    `eval(tok=${json.eval_count} ms=${evalMs} = ${tokPerSec}tok/s)`,
    `load=${loadMs}ms`,
    `sys[${fingerprintSystem(body)}]`);
  return json;
}

export class LocalProvider implements MasterProvider {
  readonly name = 'local' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const systemMsg = anthropicSystemToOllamaMessage(input.systemBlocks);
    const messages: OllamaMessage[] = prependNoThinkIfQwen3([
      ...(systemMsg ? [systemMsg] : []),
      ...anthropicMessagesToOllama(input.messages),
    ], input.model);
    const json = await chat({
      model: input.model,
      messages,
      tools: input.tools.map(anthropicToolToOllama),
      stream: false,
      keep_alive: KEEP_ALIVE,
      think: isThinkingModel(input.model) ? false : undefined,
      options: { num_predict: input.maxTokens ?? 4096, num_ctx: NUM_CTX },
    });
    const contentBlocks = ollamaResponseToContentBlocks(json.message);
    const hasToolCalls = contentBlocks.some((b) => b.type === 'tool_use');
    return {
      contentBlocks,
      stopReason: ollamaDoneReasonToStopReason(json.done_reason, hasToolCalls),
      usage: normalizeOllamaUsage({
        prompt_eval_count: json.prompt_eval_count,
        eval_count: json.eval_count,
      }),
    };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    try {
      const langModel = process.env.OLLAMA_LANGUAGE_MODEL ?? process.env.OLLAMA_MASTER_MODEL;
      const json = await chat({
        model: langModel,
        messages: [
          { role: 'system', content: 'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.' },
          { role: 'user', content: input.text },
        ],
        stream: false,
        keep_alive: KEEP_ALIVE,
        think: isThinkingModel(langModel) ? false : undefined,
        options: { num_predict: 8, num_ctx: NUM_CTX },
      });
      if (input.userId) {
        await recordUsage({
          userId: input.userId,
          sessionId: input.sessionId ?? null,
          endpoint: 'language',
          model: 'ollama-local',
          usage: normalizeOllamaUsage({
            prompt_eval_count: json.prompt_eval_count,
            eval_count: json.eval_count,
          }),
        });
      }
      const code = json.message.content.trim().toLowerCase();
      return /^[a-z]{2}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }

  async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    const json = await chat({
      model: input.model,
      messages: prependNoThinkIfQwen3([
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ], input.model),
      tools: [anthropicToolToOllama(input.toolDefinition)],
      stream: false,
      keep_alive: KEEP_ALIVE,
      think: isThinkingModel(input.model) ? false : undefined,
      options: { num_predict: 1024, num_ctx: NUM_CTX },
    });
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'wizard',
        model: input.model ?? 'ollama-local',
        usage: normalizeOllamaUsage({
          prompt_eval_count: json.prompt_eval_count,
          eval_count: json.eval_count,
        }),
      });
    }
    const blocks = ollamaResponseToContentBlocks(json.message);
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name === input.toolDefinition.name) {
        return {
          toolInput: b.input,
          usage: normalizeOllamaUsage({
            prompt_eval_count: json.prompt_eval_count,
            eval_count: json.eval_count,
          }),
        };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
}
