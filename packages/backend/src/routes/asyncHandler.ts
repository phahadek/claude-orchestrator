import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import { logger } from '../logger';
import { recordFault } from '../audit/recordFault';

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Express 4 does not forward a rejected promise from an async route handler
 * to error middleware — the rejection escapes to the process-level
 * unhandledRejection handler and no response is ever sent. This wrapper
 * forwards both rejections and synchronous throws to next().
 */
export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Terminal error boundary for handlers wrapped in asyncHandler. Must be
 * registered last, after every router mount — Express selects error
 * middleware by position. Never leaks a stack or error message to the
 * client; detail goes to the log and the audit event instead.
 */
export const asyncErrorBoundary: ErrorRequestHandler = (
  err,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(
    `[server] unhandled route error: ${error.stack || error.message}`,
  );
  recordFault('routeError', error, false);
  res.status(500).json({ error: 'Internal server error' });
};
