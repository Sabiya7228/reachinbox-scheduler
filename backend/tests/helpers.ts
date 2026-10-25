import { sql } from 'drizzle-orm';
import { Job } from 'bullmq';
import { db } from '../src/db';
import { campaigns, emails, users } from '../src/db/schema';
import { redis } from '../src/lib/redis';
import type { Mailer, OutgoingEmail } from '../src/services/mailer';
import type { RateLimitNotifier } from '../src/services/slackService';
import type { SearchIndexer } from '../src/services/searchService';

export async function resetState() {
  await db.execute(sql`TRUNCATE emails, campaigns, users RESTART IDENTITY CASCADE`);
  await redis.flushdb();
}

export async function createUser() {
  const [u] = await db
    .insert(users)
    .values({ googleId: `g-${Math.random()}`, email: 'student@example.com', name: 'Student' })
    .returning();
  return u;
}

export async function createEmailRows(userId: string, n: number, opts: { hourlyLimit?: number; at?: Date; sender?: string } = {}) {
  const sender = opts.sender ?? 'sender1@ethereal.email';
  const [c] = await db
    .insert(campaigns)
    .values({
      userId,
      senderEmail: sender,
      subject: 'Hello',
      body: 'Body',
      startTime: opts.at ?? new Date(),
      delayBetweenMs: 0,
      hourlyLimit: opts.hourlyLimit ?? 1000,
      totalRecipients: n,
    })
    .returning();
  return db
    .insert(emails)
    .values(
      Array.from({ length: n }, (_, i) => ({
        campaignId: c.id,
        userId,
        senderEmail: sender,
        recipient: `lead${i}@example.com`,
        subject: 'Hello',
        body: 'Body',
        scheduledAt: opts.at ?? new Date(),
      })),
    )
    .returning();
}

/** Fake mailer used ONLY in tests: records every send so we can count duplicates. */
export class RecordingMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  /** Time each send() call started — i.e. when SMTP would actually be contacted. */
  callTimes: number[] = [];
  failTimes = 0;
  delayMs = 0;
  async send(email: OutgoingEmail) {
    this.callTimes.push(Date.now());
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('SMTP 421 try again later');
    }
    this.sent.push(email);
    return { messageId: `<${this.sent.length}@test>`, previewUrl: null };
  }
}

export class RecordingNotifier implements RateLimitNotifier {
  calls: { userId: string; sender: string; window: number; limit: number }[] = [];
  async notifyLimitReached(args: { userId: string; sender: string; window: number; limit: number }) {
    this.calls.push(args);
  }
}

export const noopSearch: SearchIndexer = { indexEmails: async () => {} };

/** Minimal stand-in for a BullMQ Job, for calling the processor directly. */
export function fakeJob(emailId: string, attemptsMade = 0, attempts = 3) {
  return {
    data: { emailId },
    opts: { attempts },
    attemptsMade,
    updateData: async () => {},
    moveToDelayed: async () => {},
  } as unknown as Job<{ emailId: string }>;
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 15_000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}
