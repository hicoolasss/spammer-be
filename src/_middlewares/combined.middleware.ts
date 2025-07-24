import { CookieService } from '@cookie/cookie.service';
import { TokenService } from '@token/token.service';
import { LogWrapper } from '@utils';
import { NextFunction, Request, Response } from 'express';

import { RefreshTokenMiddleware } from './refresh-token.middleware';

export function combinedMiddleware(
  cookieService: CookieService,
  tokenService: TokenService,
) {
  const logger = new LogWrapper('CombinedMiddleware');
  const refreshTokenMiddleware = new RefreshTokenMiddleware(
    cookieService,
    tokenService,
  );

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await logger.info(
        `Request received. IP: ${req.ip}, ${req.headers['x-forwarded-for']}, ${req.connection.remoteAddress}`,
      );

      await new Promise<void>((resolve, reject) =>
        refreshTokenMiddleware.use(req, res, async (error?: unknown) => {
          if (error) {
            await logger.error(`Refresh token middleware failed: ${error}`);
            reject(error);
          } else {
            resolve();
          }
        }),
      );

      return next();
    } catch (error) {
      await logger.error('Failed combinedMiddleware.', error);
      next(error);
    }
  };
}
