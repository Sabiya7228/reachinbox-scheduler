import { Worker } from 'bullmq';
import { bullConnection, EMAIL_QUEUE_NAME, EmailJobData } from './emailQueue';
import { createEmailProcessor, ProcessorDeps, ProcessResult } from './emailProcessor';
import { logger } from '../lib/logger';

export function createEmailWorker(deps: ProcessorDeps, opts: { concurrency: number; queueName?: string }) {
  const processor = createEmailProcessor(deps);
  const worker = new Worker<EmailJobData, ProcessResult>(opts.queueName ?? EMAIL_QUEUE_NAME, processor, {
    connection: bullConnection(),
    concurrency: opts.concurrency, // configurable via WORKER_CONCURRENCY
  });
  worker.on('failed', (job, err) => {
    if (err?.name === 'DelayedError') return;
    logger.warn(`Job ${job?.id} failed: ${err?.message}`);
  });
  worker.on('error', (err) => logger.error('Worker error', err));
  return worker;
}
