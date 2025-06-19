import { jwtConfig } from "@_config/jwt.config";
import { CookieService } from "@cookie/cookie.service";
import { EmailModule } from "@email/email.module";
import { EmailToken, EmailTokenSchema } from "@email/emailToken.schema";
import { forwardRef, Logger, Module } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import { PassportModule } from "@nestjs/passport";
import { TokenModule } from "@token/token.module";
import { TokenService } from "@token/token.service";
import { UserModule } from "@user/user.module";
import { User, UserSchema } from "@user/user.schema";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register(jwtConfig),
    MongooseModule.forFeature([
      { name: EmailToken.name, schema: EmailTokenSchema },
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => EmailModule),
    forwardRef(() => UserModule),
    forwardRef(() => TokenModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    CookieService,
    JwtStrategy,
    JwtService,
    Logger,
    TokenService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
