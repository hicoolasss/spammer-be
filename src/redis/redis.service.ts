import { LeadData } from '@interfaces';
import { Inject, Injectable } from '@nestjs/common';
import { LogWrapper } from '@utils';
import { RedisClientType } from 'redis';

import { REDIS_CLIENT } from './redis.module';

@Injectable()
export class RedisService {
  private readonly logger = new LogWrapper(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private redisClient: RedisClientType,
  ) {}

  async getLeadData(leadKey: string): Promise<LeadData | null> {
    try {
      const data = await this.redisClient.lPop(leadKey);
      if (!data) {
        this.logger.warn(`No data found for key: ${leadKey}`);
        return null;
      }

      const parsedData = JSON.parse(data as string) as LeadData;
      this.logger.info(`Retrieved lead data: ${JSON.stringify(parsedData)}`);
      return parsedData;
    } catch (error) {
      this.logger.error(`Error getting lead data from Redis: ${error.message}`);
      throw error;
    }
  }

  async getFbclData(fbclKey: string): Promise<string | null> {
    try {
      const data = await this.redisClient.lPop(fbclKey);
      if (!data) {
        this.logger.warn(`No fbcl data found for key: ${fbclKey}`);
        return null;
      }

      this.logger.info(`Retrieved fbcl data: ${data}`);
      return data as string;
    } catch (error) {
      this.logger.error(`Error getting fbcl data from Redis: ${error.message}`);
      throw error;
    }
  }
}
