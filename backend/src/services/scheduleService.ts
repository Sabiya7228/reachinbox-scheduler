import type { Queue } from 'bullmq';
import { z } from 'zod';
import type { DB } from '../db';
import { campaigns, emails, Email } from '../db/schema';
import { enqueueEmails, EmailJobData } from '../queue/emailQueue';
import type { SearchIndexer } from './searchService';
import { isValidEmail } from './recipients';

export const MAX_RECIPIENTS = 10_000;

export const scheduleInputSchema = z.object({
  senderEmail: z.string().email(),
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  body: z.string().trim().min(1, 'Body is required').max(50_000),
  recipients: z.array(z.string().trim().toLowerCase()).min(1, 'Add at least one recipient').max(MAX_RECIPIENTS),
  startTime: z.coerce.date(),
  delayBetweenSeconds: z.coerce.number().int().min(0).max(24 * 3600),
  hourlyLimit: z.coerce.number().int().min(1).max(100_000),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

/**
 * Email i (0-based) is scheduled at: start + i × delay.
 * The worker may push it later (min delay / hourly limit), never earlier.
 */
export function computeSendTimes(start: Date, count: number, delayMs: number, now = Date.now()): Date[] {
  const base = Math.max(start.getTime(), now);
  return Array.from({ length: count }, (_, i) => new Date(base + i * delayMs));
}

export class ScheduleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface ScheduleDeps {
  db: DB;
  queue: Queue<EmailJobData>;
  search: SearchIndexer;
  allowedSenders: string[];
  maxPerHourPerSender: number;
}

/**
 * 1. Validate + dedupe recipients
 * 2. Save campaign + one row per recipient in ONE transaction (DB = source of truth)
 * 3. Add one BullMQ delayed job per row (jobId = row id)
 * If the process dies between 2 and 3, the worker's startup reconciliation re-adds the jobs.
 */
export async function scheduleCampaign(deps: ScheduleDeps, userId: string, input: ScheduleInput) {
  if (!deps.allowedSenders.includes(input.senderEmail)) {
    throw new ScheduleError(`Unknown sender "${input.senderEmail}"`);
  }
  const recipients = [...new Set(input.recipients)].filter(isValidEmail);
  if (recipients.length === 0) throw new ScheduleError('No valid recipient email addresses');

  const hourlyLimit = Math.min(input.hourlyLimit, deps.maxPerHourPerSender);
  const delayMs = input.delayBetweenSeconds * 1000;
  const times = computeSendTimes(input.startTime, recipients.length, delayMs);

  const { campaign, rows } = await deps.db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        userId,
        senderEmail: input.senderEmail,
        subject: input.subject,
        body: input.body,
        startTime: times[0],
        delayBetweenMs: delayMs,
        hourlyLimit,
        totalRecipients: recipients.length,
      })
      .returning();

    const rows: Email[] = [];
    const CHUNK = 1000; // keep each INSERT statement a reasonable size
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const inserted = await tx
        .insert(emails)
        .values(
          recipients.slice(i, i + CHUNK).map((recipient, j) => ({
            campaignId: campaign.id,
            userId,
            senderEmail: input.senderEmail,
            recipient,
            subject: input.subject,
            body: input.body,
            scheduledAt: times[i + j],
          })),
        )
        .returning();
      rows.push(...inserted);
    }
    return { campaign, rows };
  });

  await enqueueEmails(deps.queue, rows);
  await deps.search.indexEmails(rows);

  return {
    campaignId: campaign.id,
    scheduledCount: rows.length,
    skippedInvalidOrDuplicate: input.recipients.length - recipients.length,
    firstSendAt: times[0],
    lastSendAt: times[times.length - 1],
    hourlyLimit,
  };
}
