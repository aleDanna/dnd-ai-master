import { pgTable, uuid, text, jsonb, pgEnum, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { sessionMessages } from './session-messages';

export const codexKindEnum = pgEnum('codex_kind', [
  'npc',
  'location',
  'quest',
  'faction',
  'lore_fact',
  'named_item',
  'relationship',
]);

export type CodexKind = (typeof codexKindEnum.enumValues)[number];

// Per-kind payload shapes. Validated at write time in patch.ts; `data` column
// is jsonb so the DB stays simple.
export type CodexNpcData = {
  description: string;
  status: 'alive' | 'dead' | 'unknown';
  disposition: 'ally' | 'neutral' | 'hostile' | 'unknown';
  tags: string[];
};
export type CodexLocationData = { description: string; region?: string; tags: string[] };
export type CodexQuestData = {
  description: string;
  status: 'open' | 'completed' | 'failed' | 'abandoned';
  giverSlug?: string;
};
export type CodexFactionData = {
  description: string;
  pcRelation: 'ally' | 'neutral' | 'hostile' | 'unknown';
};
export type CodexLoreFactData = { statement: string; tags: string[] };
export type CodexNamedItemData = { description: string; holderSlug?: string; magical: boolean };
export type CodexRelationshipData = { fromSlug: string; toSlug: string; nature: string };

export type CodexData =
  | CodexNpcData
  | CodexLocationData
  | CodexQuestData
  | CodexFactionData
  | CodexLoreFactData
  | CodexNamedItemData
  | CodexRelationshipData;

export const codexEntities = pgTable(
  'codex_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    kind: codexKindEnum('kind').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    data: jsonb('data').$type<CodexData>().notNull(),
    lastSeenMsgId: uuid('last_seen_msg_id').references(() => sessionMessages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionKindIdx: index('codex_entities_session_kind_idx').on(t.sessionId, t.kind),
    sessionLastSeenIdx: index('codex_entities_session_last_seen_idx').on(t.sessionId, t.lastSeenMsgId),
    sessionKindSlugUniq: uniqueIndex('codex_entities_session_kind_slug_uniq').on(t.sessionId, t.kind, t.slug),
  }),
);

export type CodexEntity = typeof codexEntities.$inferSelect;
export type CodexEntityInsert = typeof codexEntities.$inferInsert;
