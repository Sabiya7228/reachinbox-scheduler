import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';
import { db, pool } from '../src/db';
import { emails, users } from '../src/db/schema';
import { redis } from '../src/lib/redis';
import { createApp } from '../src/app';
import { createEmailQueue } from '../src/queue/emailQueue';
import type { SearchService } from '../src/services/searchService';
import { createUser, resetState } from './helpers';

const queue = createEmailQueue('email-send-api-test');
const fakeSearch = {
  indexEmails: async () => {},
  search: vi.fn(async () => [] as string[]),
} as unknown as SearchService;

// Test-only login: the header x-test-user puts a user id in the session.
const testLogin = (req: Request, _res: Response, next: NextFunction) => {
  const id = req.header('x-test-user');
  if (id) req.session.userId = id;
  next();
};

const app = createApp({
  db,
  redis,
  queue,
  search: fakeSearch,
  allowedSenders: ['sender1@ethereal.email'],
  maxPerHourPerSender: 50,
  beforeRoutes: [testLogin],
});

const validBody = () => ({
  senderEmail: 'sender1@ethereal.email',
  subject: 'Quick question',
  body: 'Hi there!',
  recipients: ['a@example.com', 'B@example.com', 'a@example.com', 'not-an-email'],
  startTime: new Date(Date.now() + 60_000).toISOString(),
  delayBetweenSeconds: 10,
  hourlyLimit: 500,
});

beforeEach(resetState);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await pool.end();
});

describe('auth', () => {
  it('protected routes return 401 when not logged in', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/emails').expect(401);
    await request(app).post('/api/emails/schedule').send(validBody()).expect(401);
  });

  it('/me returns the logged-in user without leaking the Slack webhook', async () => {
    const u = await createUser();
    const res = await request(app).get('/api/auth/me').set('x-test-user', u.id).expect(200);
    expect(res.body).toMatchObject({ id: u.id, name: 'Student', slackConnected: false });
    expect(JSON.stringify(res.body)).not.toContain('hooks.slack.com');
  });

  it('queue dashboard redirects to login when logged out', async () => {
    const res = await request(app).get('/admin/queues').expect(302);
    expect(res.headers.location).toContain('/login');
  });

  it('queue dashboard loads when logged in', async () => {
    const u = await createUser();
    await request(app).get('/admin/queues').set('x-test-user', u.id).expect(200);
  });
});

describe('POST /api/emails/schedule', () => {
  it('stores rows, dedupes recipients, staggers times, caps the hourly limit and enqueues jobs', async () => {
    const u = await createUser();
    const res = await request(app).post('/api/emails/schedule').set('x-test-user', u.id).send(validBody()).expect(201);
    expect(res.body).toMatchObject({ scheduledCount: 2, skippedInvalidOrDuplicate: 2, hourlyLimit: 50 });

    const rows = await db.select().from(emails).orderBy(emails.scheduledAt);
    expect(rows.map((r) => r.recipient)).toEqual(['a@example.com', 'b@example.com']);
    expect(rows[1].scheduledAt.getTime() - rows[0].scheduledAt.getTime()).toBe(10_000);

    expect(await queue.getDelayedCount()).toBe(2);
    expect(await queue.getJob(rows[0].id)).toBeTruthy(); // jobId === email id
  });

  it('rejects invalid input with a readable message', async () => {
    const u = await createUser();
    const res = await request(app)
      .post('/api/emails/schedule')
      .set('x-test-user', u.id)
      .send({ ...validBody(), subject: '' })
      .expect(400);
    expect(res.body.error).toBe('Subject is required');
  });

  it('rejects unknown senders', async () => {
    const u = await createUser();
    await request(app)
      .post('/api/emails/schedule')
      .set('x-test-user', u.id)
      .send({ ...validBody(), senderEmail: 'hacker@evil.com' })
      .expect(400);
  });

  it('handles 1000+ recipients in one request', async () => {
    const u = await createUser();
    const recipients = Array.from({ length: 1500 }, (_, i) => `bulk${i}@example.com`);
    const res = await request(app)
      .post('/api/emails/schedule')
      .set('x-test-user', u.id)
      .send({ ...validBody(), recipients, delayBetweenSeconds: 0 })
      .expect(201);
    expect(res.body.scheduledCount).toBe(1500);
    expect(await queue.getDelayedCount()).toBe(1500);
  });
});

describe('GET /api/emails', () => {
  it('splits scheduled vs sent tabs and only shows the current user\'s emails', async () => {
    const me = await createUser();
    const other = await createUser();
    await request(app).post('/api/emails/schedule').set('x-test-user', me.id).send(validBody()).expect(201);
    await request(app).post('/api/emails/schedule').set('x-test-user', other.id).send(validBody()).expect(201);
    const [first] = await db.select().from(emails).where(eq(emails.userId, me.id));
    await db.update(emails).set({ status: 'sent', sentAt: new Date() }).where(eq(emails.id, first.id));

    const scheduled = await request(app).get('/api/emails?tab=scheduled').set('x-test-user', me.id).expect(200);
    const sent = await request(app).get('/api/emails?tab=sent').set('x-test-user', me.id).expect(200);
    expect(scheduled.body.total).toBe(1);
    expect(sent.body.total).toBe(1);
    expect(sent.body.items[0].status).toBe('sent');

    const stats = await request(app).get('/api/emails/stats').set('x-test-user', me.id).expect(200);
    expect(stats.body).toEqual({ scheduled: 1, sent: 1, failed: 0 });

    // can't read someone else's email
    const [theirs] = await db.select().from(emails).where(eq(emails.userId, other.id));
    await request(app).get(`/api/emails/${theirs.id}`).set('x-test-user', me.id).expect(404);
  });

  it('search returns 503 (not a crash) when Elasticsearch is down', async () => {
    const u = await createUser();
    vi.mocked(fakeSearch.search).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await request(app).get('/api/emails/search?q=hello').set('x-test-user', u.id).expect(503);
  });
});

describe('Slack OAuth routes', () => {
  it('connect → callback stores the webhook; state is single-use', async () => {
    const u = await createUser();
    const { env } = await import('../src/config/env');
    Object.assign(env, { SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'secret', SLACK_REDIRECT_URL: 'https://x.ngrok.app/api/slack/callback' });

    const connect = await request(app).get('/api/slack/connect').set('x-test-user', u.id).expect(200);
    const state = new URL(connect.body.url).searchParams.get('state')!;
    expect(connect.body.url).toContain('scope=incoming-webhook');

    // Stand-in for Slack's token endpoint (the real one needs a real browser approval).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      team: { name: 'My Team' },
      incoming_webhook: { url: 'https://hooks.slack.com/services/T/B/X', channel: '#alerts' },
    }))));

    const cb = await request(app).get(`/api/slack/callback?code=abc&state=${state}`).expect(302);
    expect(cb.headers.location).toContain('slack=connected');
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.slackWebhookUrl).toBe('https://hooks.slack.com/services/T/B/X');

    const replay = await request(app).get(`/api/slack/callback?code=abc&state=${state}`).expect(302);
    expect(replay.headers.location).toContain('slack=invalid_state');

    await request(app).delete('/api/slack').set('x-test-user', u.id).expect(200);
    const status = await request(app).get('/api/slack/status').set('x-test-user', u.id).expect(200);
    expect(status.body.connected).toBe(false);
  });
});
