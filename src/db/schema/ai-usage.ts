import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('ai_usage_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export type AiUsage = typeof aiUsage.$inferSelect;
export type AiUsageInsert = typeof aiUsage.$inferInsert;
