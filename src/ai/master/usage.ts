import { db } from '@/db/client';
import { aiUsage, type AiUsageInsert } from '@/db/schema';
import type { MasterMode } from '@/ai/master/mode';

export interface UsageNumbers {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Ollama model-load time (ms). Undefined/null → cloud provider or not reported. */
  loadDurationMs?: number;
  /** Ollama prompt-eval time / prefill (ms). Undefined/null → cloud provider or not reported. */
  promptEvalDurationMs?: number;
  /** Ollama eval time / decode (ms). Undefined/null → cloud provider or not reported. */
  evalDurationMs?: number;
}

export async function recordUsage(args: {
  userId: string;
  sessionId?: string | null;
  endpoint: 'master' | 'language' | 'wizard';
  model: string;
  usage: UsageNumbers;
  /** Plan E.1: master mode at turn execution time. */
  mode?: MasterMode;
  /** Plan E.1: whether the spellcasting overlay was injected this turn. */
  needsSpellcasting?: boolean;
}): Promise<void> {
  const row: AiUsageInsert = {
    sessionId: args.sessionId ?? null,
    userId: args.userId,
    endpoint: args.endpoint,
    model: args.model,
    inputTokens: args.usage.inputTokens ?? 0,
    outputTokens: args.usage.outputTokens ?? 0,
    cacheReadTokens: args.usage.cacheReadTokens ?? 0,
    cacheCreationTokens: args.usage.cacheCreationTokens ?? 0,
    mode: args.mode ?? null,
    needsSpellcasting: args.needsSpellcasting ?? null,
    loadDurationMs: args.usage.loadDurationMs ?? null,
    promptEvalDurationMs: args.usage.promptEvalDurationMs ?? null,
    evalDurationMs: args.usage.evalDurationMs ?? null,
  };
  await db.insert(aiUsage).values(row);
}
