import { pgTable, uuid, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { sessionMessages } from './session-messages';

export const sessionChapters = pgTable(
  'session_chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    chapterIndex: integer('chapter_index').notNull(),
    firstMsgId: uuid('first_msg_id').notNull().references(() => sessionMessages.id, { onDelete: 'restrict' }),
    lastMsgId: uuid('last_msg_id').notNull().references(() => sessionMessages.id, { onDelete: 'restrict' }),
    messageCount: integer('message_count').notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionChapterIdx: index('session_chapters_session_chapter_idx').on(t.sessionId, t.chapterIndex),
    sessionChapterUniq: uniqueIndex('session_chapters_session_chapter_uniq').on(t.sessionId, t.chapterIndex),
  }),
);

export type SessionChapter = typeof sessionChapters.$inferSelect;
export type SessionChapterInsert = typeof sessionChapters.$inferInsert;
