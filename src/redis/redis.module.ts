import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LogWrapper } from '@utils/LogWrapper';
import { createClient, RedisClientType } from 'redis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: async (config: ConfigService): Promise<RedisClientType> => {
        const logger = new LogWrapper(REDIS_CLIENT);
        const url = config.get<string>(process.env.REDIS_URL);
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
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
