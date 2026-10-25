import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Queue, Worker } from 'bullmq';
import { db, pool } from '../src/db';
import { emails } from '../src/db/schema';
import { redis } from '../src/lib/redis';
import { createEmailQueue, enqueueEmails, EmailJobData } from '../src/queue/emailQueue';
import { createEmailWorker } from '../src/queue/createWorker';
import { reconcileScheduledEmails } from '../src/queue/reconcile';
import { GateResult, RateLimiter } from '../src/services/rateLimiter';

/** RateLimiter that records the Redis time of every granted send (for assertions). */
class RecordingRateLimiter extends RateLimiter {
  grants: number[] = [];
  async acquireSendGate(sender: string, opts: { minDelayMs: number }): Promise<GateResult> {
    const r = await super.acquireSendGate(sender, opts);
    if (r.granted) this.grants.push(r.serverNow);
    return r;
  }
}
let limiter: RecordingRateLimiter;
import { scheduleCampaign } from '../src/services/scheduleService';
import { createEmailRows, createUser, noopSearch, RecordingMailer, RecordingNotifier, resetState, waitFor } from './helpers';

const QUEUE = 'email-send-test';
let queue: Queue<EmailJobData>;
const workers: Worker[] = [];

function startWorker(mailer: RecordingMailer, opts: { minDelayMs?: number; concurrency?: number } = {}) {
  const w = createEmailWorker(
    {
      db,
      mailer,
      notifier: new RecordingNotifier(),
      search: noopSearch,
      rateLimiter: limiter,
      config: { minDelayMs: opts.minDelayMs ?? 0, maxPerHourPerSender: 1000, staleSendingMs: 60_000 },
    },
    { concurrency: opts.concurrency ?? 5, queueName: QUEUE },
  );
  workers.push(w);
  return w;
}

const countSent = async () => (await db.select().from(emails).where(eq(emails.status, 'sent'))).length;

beforeEach(async () => {
  await resetState();
  queue = createEmailQueue(QUEUE);
  limiter = new RecordingRateLimiter(redis);
});
afterEach(async () => {
  // stop every worker so it can't pick up the next test's jobs
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await queue.obliterate({ force: true });
  await queue.close();
});
afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('BullMQ end-to-end', () => {
  it('delayed job is sent at (not before) its scheduled time', async () => {
    const user = await createUser();
    const at = new Date(Date.now() + 1500);
    const rows = await createEmailRows(user.id, 1, { at });
    await enqueueEmails(queue, rows);
    const mailer = new RecordingMailer();
    startWorker(mailer);

    await waitFor(async () => (await countSent()) === 1);
    const [row] = await db.select().from(emails);
    expect(row.sentAt!.getTime()).toBeGreaterThanOrEqual(at.getTime() - 50);
  });

  it('survives a restart: worker stops before send time, new worker sends exactly once', async () => {
    const user = await createUser();
    const rows = await createEmailRows(user.id, 3, { at: new Date(Date.now() + 2000) });
    await enqueueEmails(queue, rows);

    const mailerA = new RecordingMailer();
    const workerA = startWorker(mailerA);
    await new Promise((r) => setTimeout(r, 500));
    await workerA.close(); // "server goes down" before the emails are due
    expect(mailerA.sent).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 2500)); // emails become due while nothing is running

    const mailerB = new RecordingMailer();
    startWorker(mailerB); // "server comes back"
    await waitFor(async () => (await countSent()) === 3);
    await new Promise((r) => setTimeout(r, 500));
    expect(mailerB.sent).toHaveLength(3); // not lost
    expect(new Set(mailerB.sent.map((m) => m.to)).size).toBe(3); // not duplicated
  });

  it('enqueuing the same email twice creates one job (jobId dedupe)', async () => {
    const user = await createUser();
    const rows = await createEmailRows(user.id, 1, { at: new Date(Date.now() + 60_000) });
    await enqueueEmails(queue, rows);
    await enqueueEmails(queue, rows);
    expect(await queue.getDelayedCount()).toBe(1);
  });

  it('reconcile re-enqueues DB rows whose Redis job was lost, without duplicating existing ones', async () => {
    const user = await createUser();
    const rows = await createEmailRows(user.id, 4, { at: new Date(Date.now() + 500) });
    await enqueueEmails(queue, rows.slice(0, 2)); // only 2 of 4 made it to Redis

    const added = await reconcileScheduledEmails(db, queue);
    expect(added).toBe(2);
    expect(await reconcileScheduledEmails(db, queue)).toBe(0); // second run is a no-op

    const mailer = new RecordingMailer();
    startWorker(mailer);
    await waitFor(async () => (await countSent()) === 4);
    expect(mailer.sent).toHaveLength(4);
  });

  it('multiple workers with concurrency: 50 emails, each sent exactly once, min delay respected', async () => {
    const user = await createUser();
    const sched = await scheduleCampaign(
      { db, queue, search: noopSearch, allowedSenders: ['sender1@ethereal.email'], maxPerHourPerSender: 1000 },
      user.id,
      {
        senderEmail: 'sender1@ethereal.email',
        subject: 'Hi',
        body: 'Body',
        recipients: Array.from({ length: 50 }, (_, i) => `p${i}@example.com`),
        startTime: new Date(),
        delayBetweenSeconds: 0,
        hourlyLimit: 1000,
      },
    );
    expect(sched.scheduledCount).toBe(50);

    const mailer = new RecordingMailer();
    // three separate "instances", each with concurrency 5
    startWorker(mailer, { minDelayMs: 50, concurrency: 5 });
    startWorker(mailer, { minDelayMs: 50, concurrency: 5 });
    startWorker(mailer, { minDelayMs: 50, concurrency: 5 });

    await waitFor(async () => (await countSent()) === 50, 25_000);
    expect(mailer.sent).toHaveLength(50);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(50);

    // The guarantee: Redis granted every send at least 50ms after the previous one
    // (measured on Redis's clock, shared by all workers).
    const grants = [...limiter.grants].sort((a, b) => a - b);
    expect(grants).toHaveLength(50);
    const grantGaps = grants.slice(1).map((t, i) => t - grants[i]);
    expect(Math.min(...grantGaps)).toBeGreaterThanOrEqual(50);

    // Client-side, the overall rate is also respected: 50 sends span >= 49 × 50ms.
    const times = [...mailer.callTimes].sort((a, b) => a - b);
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(49 * 50 - 20);
  });
});
