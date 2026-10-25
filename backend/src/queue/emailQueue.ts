import { Queue, JobsOptions } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { env } from '../config/env';

export const EMAIL_QUEUE_NAME = 'email-send';

export interface EmailJobData {
  emailId: string;
  /** Set by the worker after reserving a rate-limit slot, so it isn't reserved twice. */
  reservedSlot?: number;
}

export function bullConnection(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    username: url.username || undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

export function createEmailQueue(name = EMAIL_QUEUE_NAME): Queue<EmailJobData> {
  return new Queue<EmailJobData>(name, {
    connection: bullConnection(),
    defaultJobOptions: {
      attempts: env.SEND_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/**
 * Adds one delayed job per email. jobId = email id, so adding the same email
 * twice is a no-op in BullMQ (first line of duplicate protection).
 */
export async function enqueueEmails(
  queue: Queue<EmailJobData>,
  items: { id: string; scheduledAt: Date }[],
  now = Date.now(),
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    await queue.addBulk(
      chunk.map((e) => ({
        name: 'send-email',
        data: { emailId: e.id },
        opts: { jobId: e.id, delay: Math.max(0, e.scheduledAt.getTime() - now) } satisfies JobsOptions,
      })),
    );
  }
}
