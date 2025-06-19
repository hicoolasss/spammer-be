import { EmailToken, EmailTokenSchema } from "@email/emailToken.schema";
import { ResetPasswordToken, ResetPasswordTokenSchema } from "@email/resetPasswordToken.schema";
import { Module } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";

import { TokenService } from "./token.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailToken.name, schema: EmailTokenSchema },
      { name: ResetPasswordToken.name, schema: ResetPasswordTokenSchema },
    ]),
  ],
  providers: [JwtService, TokenService],
  exports: [TokenService, MongooseModule],
})
export class TokenModule {}