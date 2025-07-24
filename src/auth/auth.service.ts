import { telegramRegex } from '@consts';
import { CookieService } from '@cookie/cookie.service';
import { EmailToken, EmailTokenDocument } from '@email/emailToken.schema';
import {
  ResetPasswordToken,
  ResetPasswordTokenDocument,
} from '@email/resetPasswordToken.schema';
import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { TokenService } from '@token/token.service';
import { UserDto } from '@user/dto/user.dto';
import { UserDocument } from '@user/user.schema';
import { UserService } from '@user/user.service';
import { LogWrapper } from '@utils';
import * as bcrypt from 'bcryptjs';
import { Response } from 'express';
import { Model } from 'mongoose';
import { EmailProvider } from 'src/email/providers/email.provider';

import { SignInDto, SignUpDto } from './dto/index.dto';
import { AuthErrorCode } from './errors/auth-error-codes';

@Injectable()
export class AuthService {
  private readonly logger = new LogWrapper(AuthService.name);

  constructor(
    @InjectModel(EmailToken.name)
    private readonly EmailTokenModel: Model<EmailTokenDocument>,
    @Inject(forwardRef(() => UserService))
    private readonly UserService: UserService,
    @InjectModel(ResetPasswordToken.name)
    private readonly resetPasswordTokenModel: Model<ResetPasswordTokenDocument>,
    private readonly CookieService: CookieService,
    private readonly EmailProvider: EmailProvider,
    private readonly TokenService: TokenService,
  ) {}

  //TODO: handle telegram duplicates
  async register(user: SignUpDto, referralLinkId?: string): Promise<void> {
    try {
      const exists = await this.UserService.findByEmail(user.email);
      if (exists) {
        throw new ConflictException({
          errorCode: AuthErrorCode.EMAIL_EXISTS,
          message: 'A user with this email already exists',
        });
      }

      await this.canCreateAccount(user);
      await this.UserService.createNewUser(user, referralLinkId);
    } catch (error) {
      this.logger.error(`Registration error: ${error}`);
      throw error;
    }
  }

  async refresh(
    refreshToken: string,
    res: Response,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const userId = await this.TokenService.verifyRefreshToken(refreshToken);

      const user: UserDocument | null = await this.UserService.findById(userId);

      if (!user) {
        throw new UnauthorizedException('User not found or token expired');
      }

      const { accessToken, refreshToken: newRefreshToken } =
        await this.TokenService.generateTokens(user._id.toString());

      const hashedRefreshToken: string =
        await this.TokenService.hashRefreshToken(newRefreshToken);
      await this.UserService.updateRefreshToken(
        user._id.toString(),
        hashedRefreshToken,
      );
      this.CookieService.setAuthCookies(res, accessToken, newRefreshToken);

      return { accessToken, refreshToken: newRefreshToken };
    } catch (error) {
      this.logger.error(`Error in refresh (token: ${refreshToken}): ${error}`);
      throw error;
    }
  }

  async login(user: SignInDto, res: Response): Promise<UserDto> {
    try {
      const current = await this.UserService.findByEmail(user.email);
      const ok =
        current && (await bcrypt.compare(user.password, current.password));

      if (!ok) {
        throw new UnauthorizedException({
          errorCode: AuthErrorCode.INVALID_CREDENTIALS,
          message: 'Invalid credentials',
        });
      }

      const {
        accessToken,
        refreshToken,
      }: { accessToken: string; refreshToken: string } =
        await this.TokenService.generateTokens(current._id.toString());

      const hashedRefreshToken: string =
        await this.TokenService.hashRefreshToken(refreshToken);
      await this.UserService.updateRefreshToken(
        current._id.toString(),
        hashedRefreshToken,
      );
      this.CookieService.setAuthCookies(res, accessToken, refreshToken);

      return {
        _id: current._id.toString(),
        email: current.email,
        role: current.role,
        telegram: current.telegram,
        emailVerified: current.emailVerified,
      };
    } catch (error) {
      await this.logger.error(`Error in login (user: ${user}): ${error}`);
      throw error;
    }
  }

  async requestEmailConfirmation(email: string): Promise<void> {
    try {
      const user: UserDocument | null =
        await this.UserService.findByEmail(email);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.emailVerified) {
        throw new ConflictException('User already verified');
      }

      const userId = user._id.toString();
      const emailToken = await this.EmailTokenModel.find({ email });

      if (emailToken.length) {
        await this.EmailTokenModel.findByIdAndDelete(emailToken[0]._id);
      }

      const token = await this.TokenService.generateEmailVerificationToken(
        email,
        userId,
      );

      await this.EmailProvider.sendEmailVerificationEmail(email, token);
    } catch (error) {
      await this.logger.error(
        `Error in requestEmailConfirmation (email: ${email}): ${error}`,
      );
      throw error;
    }
  }

  async requestPasswordReset(email: string): Promise<{ success: boolean }> {
    try {
      const user: UserDocument | null =
        await this.UserService.findByEmail(email);

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const userId = user._id.toString();
      const emailToken = await this.resetPasswordTokenModel.find({ email });

      if (emailToken.length) {
        await this.resetPasswordTokenModel.findByIdAndDelete(emailToken[0]._id);
      }

      const token = await this.TokenService.generatePasswordResetToken(
        email,
        userId,
      );

      if (user) {
        await this.EmailProvider.sendResetPasswordEmail(email, token);
      }
      return { success: true };
    } catch (error) {
      await this.logger.error(
        `Error in requestEmailConfirmation (email: ${email}): ${error}`,
      );
      throw error;
    }
  }

  async logout(res: Response): Promise<void> {
    this.CookieService.clearAuthCookies(res);
  }

  private async canCreateAccount(user: UserDto) {
    if (user.telegram?.length && !telegramRegex.test(user.telegram)) {
      throw new BadRequestException('Invalid Telegram username');
    }

    const existingUser: UserDocument | null =
      await this.UserService.findByEmail(user.email);

    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }
  }
}
