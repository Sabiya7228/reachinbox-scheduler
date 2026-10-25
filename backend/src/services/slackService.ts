import type IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { users } from '../db/schema';
import { logger } from '../lib/logger';

/** Posts a message to a Slack Incoming Webhook URL (obtained via OAuth). */
export async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
}

export interface RateLimitNotifier {
  notifyLimitReached(args: { userId: string; sender: string; window: number; limit: number }): Promise<void>;
}

/**
 * Sends ONE Slack alert per (user, sender, hour window).
 * - Dedupe uses Redis SET NX, so it is safe with many workers.
 * - The webhook is read from the DB on every call, so connecting/disconnecting
 *   Slack takes effect immediately without a redeploy.
 * - Never throws: a Slack problem must not break email sending.
 */
export class SlackRateLimitNotifier implements RateLimitNotifier {
  constructor(
    private readonly db: DB,
    private readonly redis: IORedis,
    private readonly post: (url: string, text: string) => Promise<void> = postToSlack,
  ) {}

  async notifyLimitReached({ userId, sender, window, limit }: { userId: string; sender: string; window: number; limit: number }) {
    try {
      const [user] = await this.db
        .select({ webhook: users.slackWebhookUrl })
        .from(users)
        .where(eq(users.id, userId));
      if (!user?.webhook) return; // Slack not connected → silently skip

      const dedupeKey = `slack:notified:${userId}:${sender}:${window}`;
      const first = await this.redis.set(dedupeKey, '1', 'EX', 2 * 60 * 60, 'NX');
      if (first !== 'OK') return; // already notified for this hour

      const windowStart = new Date(window * 60 * 60 * 1000);
      const windowEnd = new Date((window + 1) * 60 * 60 * 1000);
      await this.post(
        user.webhook,
        `:warning: *Hourly sending limit reached*\nSender \`${sender}\` hit its limit of *${limit} emails/hour* ` +
          `for the window ${windowStart.toISOString()} – ${windowEnd.toISOString()}.\n` +
          `Remaining emails were not dropped — they are automatically rescheduled into the next hour.`,
      );
      logger.info(`Slack rate-limit alert sent (user=${userId}, sender=${sender})`);
    } catch (err) {
      logger.warn('Slack notification failed (ignored)', err instanceof Error ? err.message : err);
    }
  }
}
