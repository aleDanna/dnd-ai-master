import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';

/**
 * Persistent log of `add_inventory` mutations actually applied to a character.
 * Used by the applicator's cross-turn dedup: when the master re-narrates the
 * same loot in a following turn and re-emits the tool call, we look up this
 * table and skip the second application.
 *
 * Dedup key is (sessionId, characterId, itemSlug, qty) within a recent time
 * window — `qty` is part of the key so legitimate "pick up 3 more potions,
 * different from the first 3" still applies (different qty, different row).
 *
 * Rows are bounded in growth by the cascade delete on session, and the table
 * is read-mostly; the descending-time index keeps the dedup lookup O(log n).
 */
export const inventoryGrants = pgTable(
  'inventory_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id').notNull(),
    itemSlug: text('item_slug').notNull(),
    qty: integer('qty').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionCharItemIdx: index('inventory_grants_session_char_item_idx').on(
      t.sessionId,
      t.characterId,
      t.itemSlug,
      t.createdAt,
    ),
  }),
);

export type InventoryGrant = typeof inventoryGrants.$inferSelect;
export type InventoryGrantInsert = typeof inventoryGrants.$inferInsert;
