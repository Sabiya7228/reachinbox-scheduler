import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { users } from '../src/db/schema';
import { redis } from '../src/lib/redis';
import { SlackRateLimitNotifier } from '../src/services/slackService';
import { createUser, resetState } from './helpers';

beforeEach(resetState);
afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('SlackRateLimitNotifier', () => {
  it('not connected → no call, no crash; connect later → works without restart; one alert per hour', async () => {
    const posted: string[] = [];
    const notifier = new SlackRateLimitNotifier(db, redis, async (url) => {
      posted.push(url);
    });
    const u = await createUser();
    const args = { userId: u.id, sender: 's@ethereal.email', window: 1, limit: 10 };

    await notifier.notifyLimitReached(args);
    expect(posted).toHaveLength(0);

    await db.update(users).set({ slackWebhookUrl: 'https://hooks.slack.com/x' }).where(eq(users.id, u.id));
    await Promise.all([notifier.notifyLimitReached(args), notifier.notifyLimitReached(args), notifier.notifyLimitReached(args)]);
    expect(posted).toEqual(['https://hooks.slack.com/x']); // deduped

    await notifier.notifyLimitReached({ ...args, window: 2 }); // next hour → new alert
    expect(posted).toHaveLength(2);
  });

  it('a Slack outage never throws into the email worker', async () => {
    const notifier = new SlackRateLimitNotifier(db, redis, async () => {
      throw new Error('Slack 500');
    });
    const u = await createUser();
    await db.update(users).set({ slackWebhookUrl: 'https://hooks.slack.com/x' }).where(eq(users.id, u.id));
    await expect(notifier.notifyLimitReached({ userId: u.id, sender: 's', window: 1, limit: 1 })).resolves.toBeUndefined();
  });
});
