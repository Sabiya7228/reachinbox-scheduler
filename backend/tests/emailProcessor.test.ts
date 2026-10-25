import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DelayedError } from 'bullmq';
import { db, pool } from '../src/db';
import { emails } from '../src/db/schema';
import { redis } from '../src/lib/redis';
import { createEmailProcessor } from '../src/queue/emailProcessor';
import { RateLimiter } from '../src/services/rateLimiter';
import { createEmailRows, createUser, fakeJob, noopSearch, RecordingMailer, RecordingNotifier, resetState } from './helpers';

function setup(overrides: { minDelayMs?: number; maxPerHour?: number } = {}) {
  const mailer = new RecordingMailer();
  const notifier = new RecordingNotifier();
  const process = createEmailProcessor({
    db,
    mailer,
    notifier,
    search: noopSearch,
    rateLimiter: new RateLimiter(redis),
    config: { minDelayMs: overrides.minDelayMs ?? 0, maxPerHourPerSender: overrides.maxPerHour ?? 1000, staleSendingMs: 60_000 },
  });
  return { mailer, notifier, process };
}

beforeEach(resetState);
afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('email processor', () => {
  it('sends a scheduled email and marks it sent', async () => {
    const user = await createUser();
    const [row] = await createEmailRows(user.id, 1);
    const { mailer, process } = setup();

    const res = await process(fakeJob(row.id));
    expect(res.outcome).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    const [after] = await db.select().from(emails).where(eq(emails.id, row.id));
    expect(after.status).toBe('sent');
    expect(after.sentAt).not.toBeNull();
  });

  it('idempotency: processing the same email twice sends it once', async () => {
    const user = await createUser();
    const [row] = await createEmailRows(user.id, 1);
    const { mailer, process } = setup();

    await process(fakeJob(row.id));
    const second = await process(fakeJob(row.id));
    expect(second).toEqual({ outcome: 'skipped', reason: 'already sent' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('idempotency under concurrency: 10 workers racing on one email send it once', async () => {
    const user = await createUser();
    const [row] = await createEmailRows(user.id, 1);
    const { mailer, process } = setup();
    mailer.delayMs = 200; // make the race window wide

    // Losers either skip, or (if they saw "sending") ask to be re-checked later via DelayedError.
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => process(fakeJob(row.id))));
    const sent = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'sent');
    const unexpected = results.filter((r) => r.status === 'rejected' && !(r.reason instanceof DelayedError));
    expect(sent).toHaveLength(1);
    expect(unexpected).toHaveLength(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it('hourly limit: extra emails are delayed (not dropped/failed) and Slack is notified once', async () => {
    const user = await createUser();
    const rows = await createEmailRows(user.id, 5, { hourlyLimit: 2 });
    const { mailer, notifier, process } = setup();

    const outcomes: string[] = [];
    for (const r of rows) {
      try {
        outcomes.push((await process(fakeJob(r.id))).outcome);
      } catch (e) {
        outcomes.push(e instanceof DelayedError ? 'delayed' : 'error');
      }
    }
    expect(outcomes).toEqual(['sent', 'sent', 'delayed', 'delayed', 'delayed']);
    expect(mailer.sent).toHaveLength(2);

    const statuses = await db.select().from(emails).where(eq(emails.status, 'scheduled'));
    expect(statuses).toHaveLength(3); // still scheduled, moved into the next hour
    const nextHour = (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000;
    expect(statuses.every((e) => e.scheduledAt.getTime() >= nextHour)).toBe(true);

    // limit reached on email #2 → notifier called; dedupe happens inside the real notifier
    expect(notifier.calls.length).toBeGreaterThanOrEqual(1);
    expect(notifier.calls[0]).toMatchObject({ userId: user.id, sender: 'sender1@ethereal.email', limit: 2 });
  });

  it('env MAX_EMAILS_PER_HOUR_PER_SENDER caps a higher campaign limit', async () => {
    const user = await createUser();
    const rows = await createEmailRows(user.id, 3, { hourlyLimit: 1000 });
    const { mailer, process } = setup({ maxPerHour: 1 });
    for (const r of rows) await process(fakeJob(r.id)).catch(() => null);
    expect(mailer.sent).toHaveLength(1);
  });

  it('retries on SMTP failure, then marks failed after the last attempt', async () => {
    const user = await createUser();
    const [row] = await createEmailRows(user.id, 1);
    const { mailer, process } = setup();
    mailer.failTimes = 10;

    await expect(process(fakeJob(row.id, 0, 2))).rejects.toThrow('SMTP');
    let [after] = await db.select().from(emails).where(eq(emails.id, row.id));
    expect(after.status).toBe('scheduled'); // will be retried

    await expect(process(fakeJob(row.id, 1, 2))).rejects.toThrow('SMTP');
    [after] = await db.select().from(emails).where(eq(emails.id, row.id));
    expect(after.status).toBe('failed');
    expect(after.error).toContain('SMTP');
  });

  it('an email stuck in "sending" after a crash is marked failed, never re-sent', async () => {
    const user = await createUser();
    const [row] = await createEmailRows(user.id, 1);
    await db.update(emails).set({ status: 'sending', updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(emails.id, row.id));
    const { mailer, process } = setup();

    const res = await process(fakeJob(row.id));
    expect(res.outcome).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
    const [after] = await db.select().from(emails).where(eq(emails.id, row.id));
    expect(after.status).toBe('failed');
  });

  it('an email in "sending" (not yet stale) is re-checked later, not dropped or re-sent', async () => {
    const user = await createUser();
    const [row] = await createEmailRows(user.id, 1);
    await db.update(emails).set({ status: 'sending', updatedAt: new Date() }).where(eq(emails.id, row.id));
    const { mailer, process } = setup();

    await expect(process(fakeJob(row.id))).rejects.toBeInstanceOf(DelayedError);
    expect(mailer.sent).toHaveLength(0);
  });
});
