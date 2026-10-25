import { env } from './config/env';
import { db, pool } from './db';
import { redis } from './lib/redis';
import { logger } from './lib/logger';
import { createEmailQueue } from './queue/emailQueue';
import { createEmailWorker } from './queue/createWorker';
import { reconcileScheduledEmails } from './queue/reconcile';
import { EtherealMailer } from './services/mailer';
import { RateLimiter } from './services/rateLimiter';
import { SlackRateLimitNotifier } from './services/slackService';
import { SearchService } from './services/searchService';

/**
 * Worker process entry point. You can run several of these at once
 * (multiple terminals / containers); all coordination happens in Redis + Postgres.
 */
async function main() {
  const queue = createEmailQueue();
  const search = new SearchService();
  await search.ensureIndex().catch((e) => logger.warn('Elasticsearch not reachable yet', e.message));

  const staleSendingMs = 5 * 60 * 1000;
  await reconcileScheduledEmails(db, queue, { staleSendingMs });

  const worker = createEmailWorker(
    {
      db,
      mailer: new EtherealMailer(),
      rateLimiter: new RateLimiter(redis),
      notifier: new SlackRateLimitNotifier(db, redis),
      search,
      config: {
        minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
        maxPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        staleSendingMs,
      },
    },
    { concurrency: env.WORKER_CONCURRENCY },
  );
  logger.info(
    `Worker started (concurrency=${env.WORKER_CONCURRENCY}, minDelay=${env.MIN_DELAY_BETWEEN_EMAILS_MS}ms, ` +
      `maxPerHourPerSender=${env.MAX_EMAILS_PER_HOUR_PER_SENDER})`,
  );

  // Graceful shutdown: finish in-flight jobs, then exit.
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down worker...`);
    await worker.close();
    await queue.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Worker failed to start', err);
  process.exit(1);
});
