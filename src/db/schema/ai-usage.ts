import { pgTable, uuid, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    /** Plan E.1: master mode at turn execution time (master endpoint only). */
    mode: text('mode'),
    /** Plan E.1: whether the spellcasting overlay was injected this turn. */
    needsSpellcasting: boolean('needs_spellcasting'),
    /**
     * Plan E.2: how many RAG chunks were retrieved for this turn.
     *
     * Three-state semantic (the hit-rate metric depends on it):
     *  - NULL → retrieval not attempted (RAG disabled by user pref OR
     *           mechanical-action gate skipped it). Excluded from hit-rate.
     *  - 0    → retrieval ran but returned no chunks (real miss).
     *  - >0   → retrieval returned chunks (hit).
     *
     * Validation query: `SELECT … WHERE rag_chunk_count IS NOT NULL`.
     */
    ragChunkCount: integer('rag_chunk_count'),
    /**
     * Ollama model-load time (ms) — cold-start cost paid on the first call
     * after the model was evicted from VRAM. Typically 0-2s on a warm model
     * and 30-120s on a cold one. NULL for cloud providers.
     */
    loadDurationMs: integer('load_duration_ms'),
    /**
     * Ollama prompt-eval time (ms) — time spent processing the input tokens
     * (prefill phase). Proportional to prompt length; grows with system prompt +
     * history + RAG chunks. NULL for cloud providers.
     */
    promptEvalDurationMs: integer('prompt_eval_duration_ms'),
    /**
     * Ollama eval time (ms) — time spent generating output tokens (decode
     * phase). Proportional to response length; bounded by num_predict cap.
     * NULL for cloud providers.
     */
    evalDurationMs: integer('eval_duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('ai_usage_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export type AiUsage = typeof aiUsage.$inferSelect;
export type AiUsageInsert = typeof aiUsage.$inferInsert;
