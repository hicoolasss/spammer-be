import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '@token/token.service';
import { UserService } from '@user/user.service';
import { LogWrapper } from '@utils';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class SetUserMiddleware implements NestMiddleware {
  private readonly logger = new LogWrapper(SetUserMiddleware.name);

  constructor(
    private readonly TokenService: TokenService,
    private readonly UserService: UserService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const accessToken = req.cookies?.accessToken;

    if (!accessToken) {
      const message = 'Access token is missing.';
      await this.logger.warn(message);
      throw new UnauthorizedException(message);
    }

    try {
      const userId = await this.TokenService.verifyAccessToken(accessToken);
      if (!userId) {
        const message = 'Invalid token: user ID not found.';
        await this.logger.warn(message);
        throw new UnauthorizedException(message);
      }

      const user = await this.UserService.getUserDtoById(userId);
      if (!user) {
        const message = 'User not found.';
        await this.logger.warn(message);
        throw new UnauthorizedException(message);
      }

      res.locals.user = user;

      next();
    } catch (error) {
      const message = 'Failed to authenticate user.';
      await this.logger.error(message, error.stack);
      throw new UnauthorizedException(message);
    }
  }
}
