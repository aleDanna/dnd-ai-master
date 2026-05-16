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
// (system + history + 18 tool defs is typically 4-16k tokens). Override to
// 24k by default; user can raise via env if running a model with bigger ctx.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? '24576');

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
  eval_count?: number;
}

async function chat(body: unknown): Promise<OllamaChatResponse> {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama chat ${res.status}: ${text}`);
  }
  return await res.json() as OllamaChatResponse;
}

export class LocalProvider implements MasterProvider {
  readonly name = 'local' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const systemMsg = anthropicSystemToOllamaMessage(input.systemBlocks);
    const messages: OllamaMessage[] = [
      ...(systemMsg ? [systemMsg] : []),
      ...anthropicMessagesToOllama(input.messages),
    ];
    const json = await chat({
      model: input.model,
      messages,
      tools: input.tools.map(anthropicToolToOllama),
      stream: false,
      keep_alive: KEEP_ALIVE,
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
      const json = await chat({
        model: process.env.OLLAMA_LANGUAGE_MODEL ?? process.env.OLLAMA_MASTER_MODEL,
        messages: [
          { role: 'system', content: 'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.' },
          { role: 'user', content: input.text },
        ],
        stream: false,
        keep_alive: KEEP_ALIVE,
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
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ],
      tools: [anthropicToolToOllama(input.toolDefinition)],
      stream: false,
      keep_alive: KEEP_ALIVE,
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
