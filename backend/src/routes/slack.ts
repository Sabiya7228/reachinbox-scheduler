import { Router } from 'express';
import crypto from 'node:crypto';
import type IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { env } from '../config/env';
import type { DB } from '../db';
import { users } from '../db/schema';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { postToSlack } from '../services/slackService';
import { getUser } from '../services/userService';
import { logger } from '../lib/logger';

const STATE_TTL_SECONDS = 600;
export const slackConfigured = () => Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_REDIRECT_URL);

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  team?: { name?: string };
  incoming_webhook?: { url: string; channel: string };
}

/**
 * Real Slack OAuth v2 with the `incoming-webhook` scope:
 *  1. /connect → we create a random `state`, store state→userId in Redis, send user to Slack.
 *  2. User picks a channel and approves.
 *  3. Slack redirects to /callback?code&state → we verify state, exchange code for a webhook URL,
 *     and save it on the user. Notifications start immediately (webhook is read per alert).
 * The state lives in Redis (not the cookie) because Slack's callback may arrive on a
 * different host (an HTTPS tunnel like ngrok) where the browser's session cookie isn't sent.
 */
export function slackRouter(db: DB, redis: IORedis) {
  const r = Router();

  r.get(
    '/status',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await getUser(db, req.session.userId!);
      res.json({
        configured: slackConfigured(),
        connected: Boolean(user?.slackWebhookUrl),
        channel: user?.slackChannel ?? null,
        team: user?.slackTeam ?? null,
      });
    }),
  );

  r.get(
    '/connect',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!slackConfigured()) {
        res.status(503).json({ error: 'Slack is not configured on the server' });
        return;
      }
      const state = crypto.randomBytes(24).toString('hex');
      await redis.set(`slack:oauth:${state}`, req.session.userId!, 'EX', STATE_TTL_SECONDS);
      const url = new URL('https://slack.com/oauth/v2/authorize');
      url.searchParams.set('client_id', env.SLACK_CLIENT_ID);
      url.searchParams.set('scope', 'incoming-webhook');
      url.searchParams.set('redirect_uri', env.SLACK_REDIRECT_URL);
      url.searchParams.set('state', state);
      res.json({ url: url.toString() });
    }),
  );

  r.get(
    '/callback',
    asyncHandler(async (req, res) => {
      const done = (result: string) => res.redirect(`${env.FRONTEND_URL}/dashboard?slack=${result}`);
      const { code, state, error } = req.query as Record<string, string | undefined>;
      if (error || !code || !state) return done('cancelled');

      // GETDEL = read + delete in one step, so a state can only be used once.
      const userId = await redis.getdel(`slack:oauth:${state}`);
      if (!userId) return done('invalid_state');

      const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID,
          client_secret: env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: env.SLACK_REDIRECT_URL,
        }),
      });
      const data = (await tokenRes.json()) as SlackOAuthResponse;
      if (!data.ok || !data.incoming_webhook) {
        logger.warn(`Slack OAuth exchange failed: ${data.error}`);
        return done('error');
      }

      await db
        .update(users)
        .set({
          slackWebhookUrl: data.incoming_webhook.url,
          slackChannel: data.incoming_webhook.channel,
          slackTeam: data.team?.name ?? null,
        })
        .where(eq(users.id, userId));
      logger.info(`Slack connected for user ${userId} (${data.incoming_webhook.channel})`);
      done('connected');
    }),
  );

  r.post(
    '/test',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await getUser(db, req.session.userId!);
      if (!user?.slackWebhookUrl) {
        res.status(400).json({ error: 'Slack is not connected' });
        return;
      }
      await postToSlack(user.slackWebhookUrl, ':white_check_mark: ReachInbox scheduler is connected to this channel.');
      res.json({ ok: true });
    }),
  );

  r.delete(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      await db
        .update(users)
        .set({ slackWebhookUrl: null, slackChannel: null, slackTeam: null })
        .where(eq(users.id, req.session.userId!));
      res.json({ ok: true });
    }),
  );

  return r;
}
