import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { LogWrapper } from '@utils/LogWrapper';
import axios from 'axios';
import { Request } from 'express';
import * as qs from 'querystring';

@Injectable()
export class CaptchaGuard implements CanActivate {
  private readonly logger = new LogWrapper(CaptchaGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const captchaToken =
      request.body?.captchaToken || request.headers['captcha-token'];

    if (!captchaToken) {
      await this.logger.warn('🚨 Captcha token is missing in request.');
      throw new BadRequestException('Captcha verification required.');
    }

    await this.logger.info(`🔍 Verifying captcha`);

    const isValid = await this.verifyCaptcha(captchaToken);
    if (!isValid) {
      await this.logger.warn(`❌ Captcha verification failed`);
      throw new ForbiddenException('Captcha verification failed.');
    }

    await this.logger.info(`✅ Captcha verification passed`);
    return true;
  }

  private async verifyCaptcha(token: string): Promise<boolean> {
    try {
      const secret = process.env.CLOUDFLARE_SECRET_KEY;

      if (!secret) {
        await this.logger.error(
          '❌ CLOUDFLARE_SECRET_KEY is missing in environment variables!',
        );
        return false;
      }
      const formData = qs.stringify({
        secret,
        response: token,
      });

      const response = await axios.post(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        formData,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.data.success) {
        await this.logger.warn(
          `🚨 Cloudflare CAPTCHA validation failed. Response: ${JSON.stringify(response.data)}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      await this.logger.error('❌ CAPTCHA validation error:', error.message);
      return false;
    }
  }
}
