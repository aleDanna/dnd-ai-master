import { pgTable, uuid, text, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';

export const messageRoleEnum = pgEnum('message_role', ['player', 'master', 'system']);

export const sessionMessages = pgTable(
  'session_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    cacheBreakpoint: boolean('cache_breakpoint').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionCreatedIdx: index('session_messages_session_created_idx').on(t.sessionId, t.createdAt),
  }),
);

export type SessionMessage = typeof sessionMessages.$inferSelect;
export type SessionMessageInsert = typeof sessionMessages.$inferInsert;
