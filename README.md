# ReachInbox Email Scheduler

> Work in progress: the backend is complete and tested; the frontend and the full README come next.

## Quick start (backend)

```bash
# 1. Start Postgres, Redis and Elasticsearch
docker compose up -d

# 2. Install and configure
cd backend
npm install
cp .env.example .env        # then fill in the credentials

# 3. Create database tables
npm run db:migrate

# 4. Run (two terminals)
npm run dev                 # API on http://localhost:4000
npm run dev:worker          # worker that sends the emails

# Queue dashboard: http://localhost:4000/admin/queues (after logging in)
```

## Tests

Tests use the real Postgres and Redis from docker compose (Redis DB 1, so your dev data is untouched;
note they DO truncate the Postgres tables, so don't run them against data you want to keep).

```bash
cd backend
npm test
```

## How it works (short version)

- **Scheduling:** each recipient = one DB row + one BullMQ delayed job (`jobId` = row id, so duplicates are impossible). No cron.
- **Restarts:** Redis persists delayed jobs (AOF). On startup the worker also re-adds any `scheduled` DB rows missing from Redis.
- **No duplicate sends:** before sending, a worker atomically flips the row `scheduled → sending`; only one worker can win.
- **Hourly limit:** Redis counter per `sender + hour window` (Lua script, atomic). When full, the email is delayed into the next hour — never dropped.
- **Minimum delay:** a Redis "send gate" using Redis's own clock; only one send per sender every `MIN_DELAY_BETWEEN_EMAILS_MS` (default 2000ms) across all workers.
- **Slack:** OAuth (`incoming-webhook` scope) stores a webhook per user; one alert per sender per hour when the limit is reached.
- **Search:** emails indexed in Elasticsearch; Postgres stays the source of truth (`npm run es:reindex` rebuilds the index).
