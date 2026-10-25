import { DelayedError, Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db';
import { campaigns, emails, Email } from '../db/schema';
import type { Mailer } from '../services/mailer';
import { HOUR_MS, RateLimiter } from '../services/rateLimiter';
import type { RateLimitNotifier } from '../services/slackService';
import type { SearchIndexer } from '../services/searchService';
import { logger } from '../lib/logger';
import type { EmailJobData } from './emailQueue';

export interface ProcessorDeps {
  db: DB;
  mailer: Mailer;
  rateLimiter: RateLimiter;
  notifier: RateLimitNotifier;
  search: SearchIndexer;
  config: {
    minDelayMs: number;
    maxPerHourPerSender: number;
    /** An email stuck in "sending" longer than this is treated as interrupted by a crash. */
    staleSendingMs: number;
  };
  now?: () => number;
}

export type ProcessResult =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'skipped'; reason: string };

/** Jobs that are early by less than this are just sent (avoids tiny re-delays). */
const EARLY_TOLERANCE_MS = 100;
export const INTERRUPTED_ERROR = 'Interrupted during send (worker crash); not retried to avoid duplicates';

/**
 * Processes one "send-email" job. Steps:
 *
 *  1. Load the row. Already sent/failed → skip (idempotency).
 *  2. Reserve a rate-limit slot in Redis (hourly limit + planned spacing).
 *     If the slot is in the future → move the job to "delayed" until then
 *     (job is NOT failed or dropped) and send a Slack alert if the hour is full.
 *  3. Atomically claim the row: UPDATE ... SET status='sending' WHERE status='scheduled'.
 *     Only one worker can win this; everyone else skips (no duplicate sends).
 *     Then pass the strict "send gate" (min delay between actual sends).
 *  4. Send via SMTP, then mark 'sent'. On error: retry with backoff, then 'failed'.
 */
export function createEmailProcessor(deps: ProcessorDeps) {
  const now = deps.now ?? (() => Date.now());

  async function updateAndIndex(id: string, values: Partial<Email>): Promise<void> {
    const [row] = await deps.db
      .update(emails)
      .set({ ...values, updatedAt: new Date(now()) })
      .where(eq(emails.id, id))
      .returning();
    // Fire-and-forget: Elasticsearch is a secondary index and must never block sending.
    if (row) void deps.search.indexEmails([row]);
  }

  return async function processEmailJob(job: Job<EmailJobData>, token?: string): Promise<ProcessResult> {
    const { emailId } = job.data;

    // ---- 1. Load + idempotency checks -------------------------------------
    const [row] = await deps.db
      .select({ email: emails, hourlyLimit: campaigns.hourlyLimit })
      .from(emails)
      .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
      .where(eq(emails.id, emailId));

    if (!row) return { outcome: 'skipped', reason: 'email row not found' };
    const email = row.email;

    if (email.status === 'sent' || email.status === 'failed') {
      return { outcome: 'skipped', reason: `already ${email.status}` };
    }
    if (email.status === 'sending') {
      // Either another worker is sending it right now, or a crash interrupted the send.
      const staleAt = email.updatedAt.getTime() + deps.config.staleSendingMs;
      if (now() >= staleAt) {
        // We cannot know if SMTP accepted it before the crash. To guarantee
        // "never sent twice", we mark it failed instead of re-sending.
        await updateAndIndex(email.id, { status: 'failed', error: INTERRUPTED_ERROR });
        return { outcome: 'skipped', reason: 'stale sending → marked failed' };
      }
      // Not stale yet: check again later (never just drop it, or it could stay "sending" forever).
      await job.moveToDelayed(staleAt + 1000, token);
      throw new DelayedError();
    }

    // ---- 2. Rate limiting (distributed, via Redis) ------------------------
    const limit = Math.min(row.hourlyLimit, deps.config.maxPerHourPerSender);
    const current = now();
    const reserved = job.data.reservedSlot;
    // A reservation only counts for the hour window it was made in. If the job wakes
    // up in a later hour (e.g. after downtime) it must reserve again, so overdue
    // emails can never sneak past the current hour's limit.
    const reservationStillValid =
      reserved !== undefined &&
      current >= reserved - EARLY_TOLERANCE_MS &&
      Math.floor(reserved / HOUR_MS) === Math.floor(current / HOUR_MS);

    if (!reservationStillValid) {
      const r = await deps.rateLimiter.reserveSlot(email.senderEmail, {
        now: current,
        minDelayMs: deps.config.minDelayMs,
        limit,
      });

      // Slack alert the moment the hour fills up (or when we overflow into the next hour).
      if (r.countInWindow >= limit || r.rolledToNextHour) {
        const fullWindow = r.rolledToNextHour ? r.window - 1 : r.window;
        await deps.notifier.notifyLimitReached({ userId: email.userId, sender: email.senderEmail, window: fullWindow, limit });
      }

      if (r.slot > current + EARLY_TOLERANCE_MS) {
        // Not allowed yet: remember the slot and park the job until then.
        await job.updateData({ ...job.data, reservedSlot: r.slot });
        await updateAndIndex(email.id, { scheduledAt: new Date(r.slot) });
        await job.moveToDelayed(r.slot, token);
        logger.info(`Email ${email.id} delayed to ${new Date(r.slot).toISOString()}${r.rolledToNextHour ? ' (hourly limit)' : ''}`);
        throw new DelayedError(); // tells BullMQ: "not a failure, I moved myself to delayed"
      }
    }

    // ---- 3. Atomic claim (exactly one worker wins) ------------------------
    const claimed = await deps.db
      .update(emails)
      .set({ status: 'sending', attempts: sql`${emails.attempts} + 1`, updatedAt: new Date(now()) })
      .where(and(eq(emails.id, email.id), eq(emails.status, 'scheduled')))
      .returning({ id: emails.id });

    if (claimed.length === 0) return { outcome: 'skipped', reason: 'claimed by another worker' };

    // Strict minimum delay, checked as the LAST step before SMTP so nothing
    // (like a slow DB call) can bunch sends together after passing the gate.
    const gate = await deps.rateLimiter.acquireSendGate(email.senderEmail, { minDelayMs: deps.config.minDelayMs });
    if (!gate.granted) {
      // Too soon after this sender's previous send: release our claim and come back.
      await deps.db
        .update(emails)
        .set({ status: 'scheduled', attempts: sql`${emails.attempts} - 1`, updatedAt: new Date(now()) })
        .where(and(eq(emails.id, email.id), eq(emails.status, 'sending')));
      // retryAt is in Redis time; convert to a wait relative to our clock.
      await job.moveToDelayed(now() + Math.max(1, gate.retryAt - gate.serverNow), token);
      throw new DelayedError();
    }

    // ---- 4. Send ----------------------------------------------------------
    try {
      const result = await deps.mailer.send({
        from: email.senderEmail,
        to: email.recipient,
        subject: email.subject,
        body: email.body,
      });
      await updateAndIndex(email.id, {
        status: 'sent',
        sentAt: new Date(now()),
        messageId: result.messageId,
        previewUrl: result.previewUrl,
        error: null,
      });
      logger.info(`Sent ${email.id} → ${email.recipient}`);
      return { outcome: 'sent', messageId: result.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
      // SMTP rejected it, so it was definitely not delivered: safe to retry.
      await updateAndIndex(email.id, { status: isFinalAttempt ? 'failed' : 'scheduled', error: message });
      logger.warn(`Send failed for ${email.id} (attempt ${job.attemptsMade + 1}/${maxAttempts}): ${message}`);
      throw err; // BullMQ retries with exponential backoff, or marks the job failed
    }
  };
}
