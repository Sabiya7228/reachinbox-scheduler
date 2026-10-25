import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres DB and Redis DB, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
      SESSION_SECRET: 'test-secret-test-secret',
      ETHEREAL_SENDERS: 'sender1@ethereal.email:x,sender2@ethereal.email:y',
    },
  },
});
