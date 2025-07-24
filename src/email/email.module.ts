import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { TokenService } from '@token/token.service';

import { EmailToken, EmailTokenSchema } from './emailToken.schema';
import { EmailProvider } from './providers/email.provider';
import {
  ResetPasswordToken,
  ResetPasswordTokenSchema,
} from './resetPasswordToken.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailToken.name, schema: EmailTokenSchema },
      { name: ResetPasswordToken.name, schema: ResetPasswordTokenSchema },
    ]),
  ],
  providers: [EmailProvider, JwtService, TokenService],
  exports: [EmailProvider],
})
export class EmailModule {}
