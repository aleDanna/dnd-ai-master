import { pgTable, uuid, text, integer, jsonb, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { sessionMessages } from './session-messages';

export const diceKindEnum = pgEnum('dice_kind', ['attack', 'damage', 'save', 'check', 'init', 'generic']);

export const diceLog = pgTable(
  'dice_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => sessionMessages.id, { onDelete: 'set null' }),
    kind: diceKindEnum('kind').notNull(),
    formula: text('formula').notNull(),
    rolls: integer('rolls').array().notNull(),
    modifier: integer('modifier').notNull().default(0),
    total: integer('total').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionCreatedIdx: index('dice_log_session_created_idx').on(t.sessionId, t.createdAt),
  }),
);

export type DiceLog = typeof diceLog.$inferSelect;
export type DiceLogInsert = typeof diceLog.$inferInsert;
