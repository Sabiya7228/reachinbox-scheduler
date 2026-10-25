import { env, senders } from './config/env';
import { db, pool } from './db';
import { redis } from './lib/redis';
import { logger } from './lib/logger';
import { createEmailQueue } from './queue/emailQueue';
import { SearchService } from './services/searchService';
import { createApp } from './app';

async function main() {
  const queue = createEmailQueue();
  const search = new SearchService();
  await search.ensureIndex().catch((e) => logger.warn('Elasticsearch not reachable yet', e.message));

  if (senders.length === 0) logger.warn('No ETHEREAL_SENDERS configured — scheduling will be rejected');

  const app = createApp({
    db,
    redis,
    queue,
    search,
    allowedSenders: senders.map((s) => s.email),
    maxPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
  });

  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`);
    logger.info(`Queue dashboard: http://localhost:${env.PORT}/admin/queues`);
  });

  const shutdown = () => {
    server.close(async () => {
      await queue.close();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('API failed to start', err);
  process.exit(1);
});
