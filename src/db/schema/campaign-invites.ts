import { pgTable, text, uuid, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';
import { users } from './users';

export const campaignInvites = pgTable(
  'campaign_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    createdByUserId: text('created_by_user_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    usesCount: integer('uses_count').notNull().default(0),
  },
  (t) => ({
    tokenIdx: index('campaign_invites_token_idx').on(t.token),
    campaignIdx: index('campaign_invites_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignInvite = typeof campaignInvites.$inferSelect;
export type CampaignInviteInsert = typeof campaignInvites.$inferInsert;
