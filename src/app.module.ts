import { jwtConfig } from '@_config/jwt.config';
import { RefreshTokenMiddleware, SetUserMiddleware } from '@_middlewares';
import { AdminController } from '@admin/admin.controller';
import { AdminModule } from '@admin/admin.module';
import { AIModule } from '@ai/ai.module';
import { AuthModule } from '@auth/auth.module';
import { CookieModule } from '@cookie/cookie.module';
import { CookieService } from '@cookie/cookie.service';
import { EmailModule } from '@email/email.module';
import { GeoProfileController } from '@geo-profile/geo-profile.controller';
import { GeoProfileModule } from '@geo-profile/geo-profile.module';
import { GeoRegionsModule } from '@geo-regions/geo-regions.module';
import { Logger, MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@redis/redis.module';
import { TaskController } from '@task/task.controller';
import { TaskModule } from '@task/task.module';
import { TokenModule } from '@token/token.module';
import { TokenService } from '@token/token.service';
import { UserController } from '@user/user.controller';
import { UserModule } from '@user/user.module';
import { LogWrapper } from '@utils';
import mongoose from 'mongoose';

import { AppController } from './app.controller';
import { CaptchaModule } from './captcha/captcha.module';
import { PuppeteerModule } from './puppeteer/puppeteer.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGO_URL'),
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        serverSelectionTimeoutMS: 5_000,
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
    GeoRegionsModule,
    GeoProfileModule,
    PuppeteerModule,
    RedisModule,
    TaskModule,
    CaptchaModule,
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
      .forRoutes(
        UserController,
        AdminController,
        GeoProfileController,
        TaskController,
      );
  }

  private setupMongooseEventListeners() {
    const connection = mongoose.connection;

    connection.on('connected', async () => {
      await this.logger.info('Database connection established.');
    });

    connection.on('disconnected', async () => {
      await this.logger.warn(
        'Database connection lost. Attempting to reconnect...',
      );
    });

    connection.on('reconnected', async () => {
      await this.logger.info('Reconnected to the database.');
    });

    connection.on('error', async (err) => {
      await this.logger.error('Database connection error:', err);
    });
  }
}
