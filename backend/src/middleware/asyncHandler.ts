import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 doesn't catch errors from async handlers; this forwards them to the error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
