import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LogWrapper } from '@utils';
import { createClient, RedisClientType } from 'redis';

import { RedisService } from './redis.service';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    ConfigService,
    {
      provide: REDIS_CLIENT,
      useFactory: async (config: ConfigService): Promise<RedisClientType> => {
        const logger = new LogWrapper(REDIS_CLIENT);
        const url = config.get<string>('REDIS_URL');
        const client: RedisClientType = createClient({ url });

        client.on('error', (err) => {
          logger.error(`Redis error: ${err.message}`);
        });
        client.on('connect', () => {
          logger.debug('Connected to Redis');
        });
        client.on('ready', () => {
          logger.debug('Redis client is ready to use');
        });
        client.on('end', () => {
          logger.warn('Redis connection closed');
        });

        await client.connect();
        return client;
      },
      inject: [ConfigService],
    },
    {
      provide: RedisService,
      useFactory: (redisClient: RedisClientType) => {
        return new RedisService(redisClient);
      },
      inject: [REDIS_CLIENT],
    },
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
