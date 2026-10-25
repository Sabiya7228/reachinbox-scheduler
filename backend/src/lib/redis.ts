import IORedis, { RedisOptions } from 'ioredis';
import { env } from '../config/env';

/**
 * BullMQ requires maxRetriesPerRequest = null on its connections.
 * We create one shared connection for app use and let BullMQ create its own.
 */
export const redisOptions: RedisOptions = { maxRetriesPerRequest: null };

export function createRedis(): IORedis {
  return new IORedis(env.REDIS_URL, redisOptions);
}

export const redis = createRedis();
