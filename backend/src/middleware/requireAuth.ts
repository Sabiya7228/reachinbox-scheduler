import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/** For JSON API routes: 401 if not logged in. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

/** For browser pages (Bull Board): redirect to the login screen instead. */
export function requireAuthPage(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.redirect(`${env.FRONTEND_URL}/login`);
    return;
  }
  next();
}
