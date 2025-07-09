import { Module } from '@nestjs/common';

import { RedisModule } from './redis.module';
import { RedisService } from './redis.service';

@Module({
  imports: [RedisModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisServiceModule {}
