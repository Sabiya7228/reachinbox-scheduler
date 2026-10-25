import express, { RequestHandler } from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import passport from 'passport';
import type IORedis from 'ioredis';
import type { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { env } from './config/env';
import type { DB } from './db';
import { configureGoogleAuth } from './auth/google';
import { authRouter } from './routes/auth';
import { emailsRouter } from './routes/emails';
import { slackRouter } from './routes/slack';
import { errorHandler } from './middleware/errorHandler';
import { requireAuthPage } from './middleware/requireAuth';
import type { EmailJobData } from './queue/emailQueue';
import type { SearchService } from './services/searchService';

export interface AppDeps {
  db: DB;
  redis: IORedis;
  queue: Queue<EmailJobData>;
  search: SearchService;
  allowedSenders: string[];
  maxPerHourPerSender: number;
  /** Test-only hook (e.g. to log a fake user in). Never set in production. */
  beforeRoutes?: RequestHandler[];
}

/** Builds the Express app without starting it, so tests can use supertest. */
export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb' })); // room for ~10k recipients

  app.use(
    session({
      name: 'sid',
      store: new RedisStore({ client: deps.redis, prefix: 'sess:' }),
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true, // JS can't read it → protects against XSS token theft
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  configureGoogleAuth(deps.db);
  app.use(passport.initialize());
  deps.beforeRoutes?.forEach((h) => app.use(h));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRouter(deps.db));
  app.use('/api/emails', emailsRouter(deps));
  app.use('/api/slack', slackRouter(deps.db, deps.redis));

  // Live BullMQ dashboard (logged-in users only)
  const board = new ExpressAdapter();
  board.setBasePath('/admin/queues');
  createBullBoard({ queues: [new BullMQAdapter(deps.queue)], serverAdapter: board });
  app.use('/admin/queues', requireAuthPage, board.getRouter());

  app.use(errorHandler);
  return app;
}
