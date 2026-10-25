import { Router } from 'express';
import passport from 'passport';
import { env } from '../config/env';
import type { DB } from '../db';
import type { User } from '../db/schema';
import { googleConfigured } from '../auth/google';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { getUser, toApiUser } from '../services/userService';

export function authRouter(db: DB) {
  const r = Router();

  r.get('/google', (req, res, next) => {
    if (!googleConfigured) {
      res.status(503).send('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
      return;
    }
    passport.authenticate('google', { scope: ['profile', 'email'], session: false, prompt: 'select_account' })(req, res, next);
  });

  r.get(
    '/google/callback',
    (req, res, next) =>
      passport.authenticate('google', { session: false, failureRedirect: `${env.FRONTEND_URL}/login?error=oauth` })(req, res, next),
    (req, res, next) => {
      const user = req.user as User;
      // New session id on login prevents session-fixation attacks.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.save((err2) => (err2 ? next(err2) : res.redirect(`${env.FRONTEND_URL}/dashboard`)));
      });
    },
  );

  r.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await getUser(db, req.session.userId!);
      if (!user) {
        req.session.destroy(() => res.status(401).json({ error: 'Not authenticated' }));
        return;
      }
      res.json(toApiUser(user));
    }),
  );

  r.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('sid');
      res.json({ ok: true });
    });
  });

  return r;
}
