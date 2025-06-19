import { CookieService } from "@cookie/cookie.service";
import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from "@nestjs/common";
import { TokenService } from "@token/token.service";
import { LogWrapper } from "@utils/LogWrapper";
import { NextFunction, Request, Response } from "express";

@Injectable()
export class RefreshTokenMiddleware implements NestMiddleware {
  private readonly logger = new LogWrapper(RefreshTokenMiddleware.name);

  constructor(
    private readonly CookieService: CookieService,
    private readonly TokenService: TokenService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const accessToken = req.cookies?.accessToken;
    const refreshToken = req.cookies?.refreshToken;

    try {
      if (accessToken) {
        await this.TokenService.verifyAccessToken(accessToken);
        return next();
      }

      if (!refreshToken) {
        await this.logger.warn("Refresh token not found");
        throw new UnauthorizedException("Refresh token not found");
      }

      const userId = await this.TokenService.verifyRefreshToken(refreshToken);

      const { accessToken: newAccessToken } =
        await this.TokenService.generateTokens(userId);
      this.CookieService.setAccessTokenCookie(res, newAccessToken);
      req.cookies.accessToken = newAccessToken;

      next();
    } catch (error) {
      await this.logger.error("Token verification failed", error.message);
      throw new UnauthorizedException("Token verification failed");
    }
  }
}
