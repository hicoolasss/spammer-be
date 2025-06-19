import * as dotenv from "dotenv";
dotenv.config();
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as cookieParser from "cookie-parser";
import * as express from "express";

import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [
      process.env.CLIENT_URL,
      process.env.CLIENT_STAGE_URL,
      process.env.LANDING_URL,
    ],
    credentials: true,
  });

  app.use("/webhooks", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 5500);
}

bootstrap();
