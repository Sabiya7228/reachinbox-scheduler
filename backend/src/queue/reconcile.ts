import type { Queue } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import type { DB } from '../db';
import { emails } from '../db/schema';
import { logger } from '../lib/logger';
import { enqueueEmails, EmailJobData } from './emailQueue';
import { INTERRUPTED_ERROR } from './emailProcessor';

/**
 * Safety net run on worker startup.
 *
 * Postgres is the source of truth. Any email still 'scheduled' in the DB but
 * missing from Redis (e.g. Redis data was lost, or the API crashed right after
 * the DB commit) is re-added. Existing jobs are untouched, and jobId = email id
 * means re-adding can never create a duplicate.
 */
export async function reconcileScheduledEmails(
  db: DB,
  queue: Queue<EmailJobData>,
  opts: { staleSendingMs: number } = { staleSendingMs: 5 * 60 * 1000 },
): Promise<number> {
  // Rows stuck in 'sending' long after a crash: we can't know if SMTP accepted them,
  // so mark them failed rather than risk a duplicate.
  const stale = await db
    .update(emails)
    .set({ status: 'failed', error: INTERRUPTED_ERROR, updatedAt: new Date() })
    .where(and(eq(emails.status, 'sending'), lt(emails.updatedAt, new Date(Date.now() - opts.staleSendingMs))))
    .returning({ id: emails.id });
  if (stale.length) logger.warn(`Reconcile: marked ${stale.length} interrupted 'sending' emails as failed`);

  const pending = await db
    .select({ id: emails.id, scheduledAt: emails.scheduledAt })
    .from(emails)
    .where(eq(emails.status, 'scheduled'));

  const missing: typeof pending = [];
  const BATCH = 200;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const states = await Promise.all(batch.map((e) => queue.getJobState(e.id)));
    batch.forEach((e, idx) => {
      // 'unknown' = no such job in Redis. 'completed'/'failed' with DB still
      // 'scheduled' means the job ended without sending → schedule it again.
      if (['unknown', 'completed', 'failed'].includes(states[idx] as string)) missing.push(e);
    });
  }

  if (missing.length > 0) {
    // remove finished jobs with the same id first so the new job can be added
    await Promise.all(missing.map((e) => queue.remove(e.id).catch(() => 0)));
    await enqueueEmails(queue, missing);
  }
  logger.info(`Reconcile: ${pending.length} scheduled in DB, ${missing.length} re-enqueued`);
  return missing.length;
}
