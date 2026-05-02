import { pgTable, text, serial } from 'drizzle-orm/pg-core';

export const srdRuleDoc = pgTable('srd_rule_doc', {
  id: serial('id').primaryKey(),
  sectionPath: text('section_path').notNull().unique(), // "1.3 Advantage and Disadvantage"
  anchor: text('anchor').notNull(),                      // slug of section_path
  markdown: text('markdown').notNull(),
});

export type SrdRuleDoc = typeof srdRuleDoc.$inferSelect;
export type SrdRuleDocInsert = typeof srdRuleDoc.$inferInsert;
