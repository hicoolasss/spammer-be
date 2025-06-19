import { jwtConfig } from "@_config/jwt.config";
import { RefreshTokenMiddleware, SetUserMiddleware } from "@_middlewares";
import { AIModule } from "@ai/ai.module";
import { AuthModule } from "@auth/auth.module";
import { CookieModule } from "@cookie/cookie.module";
import { CookieService } from "@cookie/cookie.service";
import { EmailModule } from "@email/email.module";
import { Logger, MiddlewareConsumer, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { MongooseModule } from "@nestjs/mongoose";
import { ScheduleModule } from "@nestjs/schedule";
import { TokenModule } from "@token/token.module";
import { TokenService } from "@token/token.service";
import { UserController } from "@user/user.controller";
import { UserModule } from "@user/user.module";
import { LogWrapper } from "@utils/LogWrapper";
import mongoose from "mongoose";

import { AdminController } from "./admin/admin.controller";
import { AdminModule } from "./admin/admin.module";
import { AppController } from "./app.controller";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>("MONGO_URL"),
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 5000,
        retryWrites: true,
      }),
      inject: [ConfigService],
    }),
    JwtModule.register(jwtConfig),
    AIModule,
    AuthModule,
    CookieModule,
    EmailModule,
    TokenModule,
    UserModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [CookieService, TokenService, Logger],
})
export class AppModule {
  private readonly logger = new LogWrapper(AppModule.name);

  constructor() {
    this.setupMongooseEventListeners();
  }

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RefreshTokenMiddleware, SetUserMiddleware)
      .forRoutes(UserController, AdminController);
  }

  private setupMongooseEventListeners() {
    const connection = mongoose.connection;

    connection.on("connected", async () => {
      await this.logger.info("Database connection established.");
    });

    connection.on("disconnected", async () => {
      await this.logger.warn(
        "Database connection lost. Attempting to reconnect..."
      );
    });

    connection.on("reconnected", async () => {
      await this.logger.info("Reconnected to the database.");
    });

    connection.on("error", async (err) => {
      await this.logger.error("Database connection error:", err);
    });
  }
}
