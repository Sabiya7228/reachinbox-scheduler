import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ScheduleError } from '../services/scheduleService';
import { logger } from '../lib/logger';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input', details: err.issues });
    return;
  }
  if (err instanceof ScheduleError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Something went wrong' });
}
