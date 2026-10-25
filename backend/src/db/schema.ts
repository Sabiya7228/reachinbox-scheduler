import { pgTable, pgEnum, uuid, text, integer, timestamp, unique, index } from 'drizzle-orm/pg-core';

export const emailStatus = pgEnum('email_status', ['scheduled', 'sending', 'sent', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  // Slack connection (per user). Null = not connected, so notifications are skipped.
  slackWebhookUrl: text('slack_webhook_url'),
  slackChannel: text('slack_channel'),
  slackTeam: text('slack_team'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One "Schedule" click = one campaign. */
export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderEmail: text('sender_email').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  delayBetweenMs: integer('delay_between_ms').notNull(),
  hourlyLimit: integer('hourly_limit').notNull(),
  totalRecipients: integer('total_recipients').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per recipient. The row id is also the BullMQ job id (dedupe). */
export const emails = pgTable(
  'emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    senderEmail: text('sender_email').notNull(),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: emailStatus('status').notNull().default('scheduled'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    messageId: text('message_id'),
    previewUrl: text('preview_url'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same recipient can't appear twice in one campaign.
    unique('emails_campaign_recipient_uq').on(t.campaignId, t.recipient),
    index('emails_user_status_idx').on(t.userId, t.status),
  ],
);

export type User = typeof users.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Email = typeof emails.$inferSelect;
export type EmailStatus = (typeof emailStatus.enumValues)[number];
