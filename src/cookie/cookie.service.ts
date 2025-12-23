import { Injectable } from '@nestjs/common';
import { IS_PROD_ENV } from '@utils';
import { Response } from 'express';

@Injectable()
export class CookieService {
  setAccessTokenCookie(res: Response, accessToken: string): void {
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: IS_PROD_ENV,
      sameSite: IS_PROD_ENV ? 'none' : 'lax',
      domain: IS_PROD_ENV ? process.env.DOMAIN : undefined,
      maxAge: parseInt(
        process.env.JWT_ACCESS_COOKIE_EXPIRATION ?? '90_0000',
        10,
      ),
    });
  }

  setRefreshTokenCookie(res: Response, refreshToken: string): void {
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: IS_PROD_ENV,
      sameSite: IS_PROD_ENV ? 'none' : 'lax',
      domain: IS_PROD_ENV ? process.env.DOMAIN : undefined,
      maxAge: 7 * 24 * 60 * 60 * 1_000,
    });
  }

  setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ): void {
    this.setAccessTokenCookie(res, accessToken);
    this.setRefreshTokenCookie(res, refreshToken);
  }

  clearAuthCookies(res: Response): void {
    res.clearCookie('accessToken', {
      httpOnly: true,
      secure: IS_PROD_ENV,
      sameSite: IS_PROD_ENV ? 'none' : 'lax',
      domain: IS_PROD_ENV ? process.env.DOMAIN : undefined,
    });
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: IS_PROD_ENV,
      sameSite: IS_PROD_ENV ? 'none' : 'lax',
      domain: IS_PROD_ENV ? process.env.DOMAIN : undefined,
    });
  }
}
