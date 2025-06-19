import { EmailToken, EmailTokenDocument } from "@email/emailToken.schema";
import {
  ResetPasswordToken,
  ResetPasswordTokenDocument,
} from "@email/resetPasswordToken.schema";
import { TokensInterface } from "@interfaces";
import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectModel } from "@nestjs/mongoose";
import * as bcrypt from "bcryptjs";
import { Model } from "mongoose";

@Injectable()
export class TokenService {
  constructor(
    private readonly JwtService: JwtService,
    @InjectModel(EmailToken.name)
    private readonly EmailTokenModel: Model<EmailTokenDocument>,
    @InjectModel(ResetPasswordToken.name)
    private readonly ResetPasswordTokenModel: Model<ResetPasswordTokenDocument>
  ) {}

  private async generateToken(
    userId: string,
    secret: string,
    expiresIn: string
  ): Promise<string> {
    const payload = { sub: userId };
    return this.JwtService.sign(payload, { secret, expiresIn });
  }

  async generateTokens(userId: string): Promise<TokensInterface> {
    const accessTokenExpiresIn: string =
      (process.env.JWT_ACCESS_TOKEN_TIME as string) || "1h";
    const accessToken: string = await this.generateToken(
      userId,
      process.env.JWT_ACCESS_TOKEN_SECRET as string,
      accessTokenExpiresIn
    );

    const refreshTokenExpiresIn: string =
      (process.env.JWT_REFRESH_TOKEN_TIME as string) || "1w";
    const refreshToken: string = await this.generateToken(
      userId,
      process.env.JWT_REFRESH_TOKEN_SECRET as string,
      refreshTokenExpiresIn
    );

    return { accessToken, refreshToken };
  }

  async hashRefreshToken(refreshToken: string): Promise<string> {
    return bcrypt.hash(refreshToken, Number(process.env.CRYPTO_SALT));
  }

  async compareRefreshTokens(
    storedTokenHash: string,
    providedToken: string
  ): Promise<boolean> {
    return bcrypt.compare(providedToken, storedTokenHash);
  }

  async generateConfirmationToken(userId: string): Promise<string> {
    const expiresIn: string =
      (process.env.JWT_CONFIRMATION_TOKEN_EXPIRATION as string) || "1h";
    const confirmationToken: string = await this.generateToken(
      userId,
      process.env.JWT_CONFIRMATION_TOKEN_SECRET as string,
      expiresIn
    );

    return confirmationToken;
  }

  async generatePasswordResetToken(
    email: string,
    userId: string
  ): Promise<string> {
    const expiresIn: string =
      (process.env.JWT_RESET_PASSWORD_TOKEN_EXPIRATION as string) || "24h";
    const expiresAt: Date = this.calcExpiresAt(expiresIn);
    const passwordResetToken: string = await this.generateToken(
      userId,
      process.env.JWT_RESET_PASSWORD_TOKEN_SECRET as string,
      expiresIn
    );

    await this.ResetPasswordTokenModel.create({
      email,
      token: passwordResetToken,
      expiresAt,
    });
    return passwordResetToken;
  }

  async generateEmailVerificationToken(
    email: string,
    userId: string
  ): Promise<string> {
    const expiresIn: string =
      (process.env.JWT_RESET_PASSWORD_TOKEN_EXPIRATION as string) || "24h";
    const expiresAt = this.calcExpiresAt(expiresIn);
    const emailVerificationToken: string = await this.generateToken(
      userId,
      process.env.JWT_EMAIL_VERIFICATION_TOKEN_SECRET as string,
      expiresIn
    );

    await this.EmailTokenModel.create({
      email,
      token: emailVerificationToken,
      expiresAt,
    });
    return emailVerificationToken;
  }

  async verifyAccessToken(token: string): Promise<string> {
    const userId = await this.verifyToken(
      token,
      process.env.JWT_ACCESS_TOKEN_SECRET as string
    );

    return userId;
  }

  async verifyConfirmationToken(token: string): Promise<string> {
    const userId = await this.verifyToken(
      token,
      process.env.JWT_CONFIRMATION_TOKEN_SECRET as string
    );

    return userId;
  }

  async verifyPasswordResetToken(
    token: string,
    consume = true
  ): Promise<string> {
    const userId = await this.verifyToken(
      token,
      process.env.JWT_RESET_PASSWORD_TOKEN_SECRET as string
    );

    const result = await this.ResetPasswordTokenModel.findOne({ token });

    if (!result) throw new BadRequestException("Token not found");

    if (result.expiresAt < new Date())
      throw new BadRequestException("Token expired");

    if (consume) await result.deleteOne();

    return userId;
  }

  async verifyEmailVerificationToken(token: string): Promise<string> {
    const userId = await this.verifyToken(
      token,
      process.env.JWT_EMAIL_VERIFICATION_TOKEN_SECRET as string
    );

    const result = await this.EmailTokenModel.findOneAndDelete({ token });

    if (!result) {
      throw new Error("Invalid or expired reset password token");
    }

    return userId;
  }

  async verifyRefreshToken(token: string): Promise<string> {
    const userId = await this.verifyToken(
      token,
      process.env.JWT_REFRESH_TOKEN_SECRET as string
    );

    return userId;
  }

  async deleteExpiredTokens(): Promise<void> {
    const now = new Date();

    await this.ResetPasswordTokenModel.deleteMany({
      expiresAt: { $lt: now },
    }).exec();

    await this.EmailTokenModel.deleteMany({
      expiresAt: { $lt: now },
    }).exec();
  }

  private async verifyToken(token: string, secret: string): Promise<string> {
    try {
      const payload = this.JwtService.verify(token, { secret });

      if (!payload || !payload.sub) {
        throw new UnauthorizedException("Invalid token");
      }

      const userId = payload.sub;
      return userId;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }

  private parseExpirationTime(expiresIn: string): number {
    const timeUnit = expiresIn.slice(-1);
    const timeValue = parseInt(expiresIn.slice(0, -1), 10);

    switch (timeUnit) {
      case "h":
        return timeValue * 3600;
      case "m":
        return timeValue * 60;
      case "s":
        return timeValue;
      default:
        throw new Error("Invalid expiration time format");
    }
  }

  private calcExpiresAt(expiresIn: string): Date {
    const expirationTime = new Date();
    expirationTime.setSeconds(
      expirationTime.getSeconds() + this.parseExpirationTime(expiresIn)
    );
    return expirationTime;
  }
}
