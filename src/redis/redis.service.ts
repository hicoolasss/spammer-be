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
    return this.safeRedisCall(
      async () => {
        const data = await this.redisClient.lPop(leadKey);
        return data ? (JSON.parse(data as string) as LeadData) : null;
      },
      `No data found for key: ${leadKey}`,
      (data) => `Retrieved lead data: ${JSON.stringify(data)}`,
    );
  }

  async getFbclidData(fbclKey: string): Promise<string | null> {
    return this.safeRedisCall(
      async () => {
        const data = await this.redisClient.lPop(fbclKey);
        return data as string;
      },
      `No fbcl data found for key: ${fbclKey}`,
      (data) => `Retrieved fbcl data: ${data}`,
    );
  }

  async getUserAgentsData(userAgentKey: string): Promise<string[]> {
    return this.safeRedisCall(
      () => this.redisClient.lRange(userAgentKey, 0, -1),
      `No user agents found for key: ${userAgentKey}`,
      (data) => `Retrieved user agents: ${data}`,
    ) as Promise<string[]>;
  }

  private async safeRedisCall<T>(
    action: () => Promise<T>,
    warnMsg: string,
    infoMsg?: (data: T) => string,
  ): Promise<T | null> {
    try {
      const data = await action();
      if (!data || (Array.isArray(data) && data.length === 0)) {
        this.logger.warn(warnMsg);
        return Array.isArray(data) ? ([] as unknown as T) : null;
      }
      if (infoMsg) this.logger.info(infoMsg(data));
      return data;
    } catch (error) {
      this.logger.error(`Redis error: ${error.message}`);
      throw error;
    }
  }
}
