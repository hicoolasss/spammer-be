import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TokenService } from '@token/token.service';
import { UserDto } from '@user/dto/user.dto';
import { UserService } from '@user/user.service';
import { Response } from 'express';
import { CaptchaGuard } from 'src/_guards/captcha.guard';

import { AuthService } from './auth.service';
import {
  RequestEmailConfirmationDto,
  RequestPasswordResetDto,
  SignInDto,
  SignUpDto,
  ValidatePasswordResetDto,
} from './dto/index.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly logger: Logger,
    private readonly AuthService: AuthService,
    private readonly TokenService: TokenService,
    private readonly UserService: UserService,
  ) {}

  @Post('sign-up')
  @UseGuards(CaptchaGuard)
  async register(
    @Body() data: SignUpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    try {
      await this.AuthService.register(data);
      res.status(HttpStatus.CREATED);
      return { success: true };
    } catch (error) {
      this.logger.error(`Registration error: ${error.message}`);
      throw error;
    }
  }

  @Post('sign-in')
  async login(
    @Body() data: SignInDto,
    @Res() res: Response,
  ): Promise<Response> {
    const user: UserDto = await this.AuthService.login(data, res);
    return res.status(HttpStatus.OK).json(user);
  }

  @Post('refresh')
  async refresh(
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { cookies: { refreshToken: string } },
  ): Promise<void> {
    try {
      const { accessToken, refreshToken } = await this.AuthService.refresh(
        req.cookies.refreshToken,
        res,
      );

      res.status(200).json({ accessToken, refreshToken });
    } catch (error) {
      this.logger.error(`Refresh token error: ${error.message}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  @Post('request-email-verification')
  async requestEmailConfirmation(
    @Body() data: RequestEmailConfirmationDto,
    @Res() res: Response,
  ): Promise<Response> {
    const { email }: { email: string } = data;
    await this.AuthService.requestEmailConfirmation(email);
    return res.status(HttpStatus.OK).json();
  }

  @Get('verify-email/:token')
  async verifyEmailConfirmation(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<Response> {
    try {
      const userId =
        await this.TokenService.verifyEmailVerificationToken(token);
      await this.UserService.permanentlyVerifyEmail(userId);
      return res
        .status(HttpStatus.OK)
        .json({ message: 'Email confirmed successfully' });
    } catch {
      throw new UnauthorizedException('Not valid token');
    }
  }

  @Post('request-password-reset')
  async requestPasswordReset(
    @Body() data: RequestPasswordResetDto,
  ): Promise<{ success: boolean }> {
    const { email }: { email: string } = data;
    const result = await this.AuthService.requestPasswordReset(email);
    return result;
  }

  @Post('reset-password/:token')
  async validatePasswordReset(
    @Param('token') token: string,
    @Body() data: ValidatePasswordResetDto,
    @Res() res: Response,
  ): Promise<Response> {
    try {
      const { password }: { password: string } = data;
      const userId = await this.TokenService.verifyPasswordResetToken(token);
      await this.UserService.updatePassword(userId, password);
      return res.status(HttpStatus.OK).json();
    } catch {
      throw new UnauthorizedException('Not valid token');
    }
  }

  @Get('reset-password/validate/:token')
  async validateLink(@Param('token') token: string) {
    await this.TokenService.verifyPasswordResetToken(token, false);
    return { valid: true };
  }

  @Get('logout')
  async logout(@Res() res: Response): Promise<Response> {
    await this.AuthService.logout(res);
    return res.status(HttpStatus.OK).json();
  }
}
