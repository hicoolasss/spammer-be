import { LeadData } from '@interfaces';
import { Inject, Injectable } from '@nestjs/common';
import { getRandomItem, LogWrapper, USER_AGENTS } from '@utils';
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

  async getUserAgentData(userAgentKey: string): Promise<string> {
    const data = (await this.safeRedisCall(
      () => this.redisClient.lRange(userAgentKey, 0, -1),
      `No user agents found for key: ${userAgentKey}`,
      (data) => `Retrieved user agents: ${data}`,
    )) as string[] | null | undefined;

    const hasNoRedisData = !data || data.length === 0;

    return getRandomItem(hasNoRedisData ? USER_AGENTS : data);
  }

  async getLeadsBatch(leadKey: string, count: number): Promise<LeadData[]> {
    return this.safeRedisCall(
      async () => {
        const data = await this.redisClient.lRange(leadKey, 0, count - 1);
        return data.map((item: string) => JSON.parse(item) as LeadData);
      },
      `No leads batch found for key: ${leadKey}`,
      (data) => `Retrieved leads batch: ${JSON.stringify(data)}`,
    ) as Promise<LeadData[]>;
  }

  async getFbclidsBatch(fbclKey: string, count: number): Promise<string[]> {
    let data = (await this.safeRedisCall(
      async () => {
        const arr = await this.redisClient.lRange(fbclKey, 0, count - 1);
        return arr as string[];
      },
      `No fbclids batch found for key: ${fbclKey}`,
      (data) => `Retrieved fbclids batch: ${data}`,
    )) as string[] | null | undefined;

    if (!data || data.length === 0) {
      return [];
    }
    if (data.length < count) {
      while (data.length < count) {
        data = data.concat(data.slice(0, count - data.length));
      }
    }
    return data.slice(0, count);
  }

  async getUserAgentsBatch(
    userAgentKey: string,
    count: number,
  ): Promise<string[]> {
    let data = (await this.safeRedisCall(
      async () => {
        const arr = await this.redisClient.lRange(userAgentKey, 0, count - 1);
        return arr as string[];
      },
      `No user agents batch found for key: ${userAgentKey}`,
      (data) => `Retrieved user agents batch: ${data}`,
    )) as string[] | null | undefined;

    if (!data || data.length === 0) {
      data = Array.from({ length: count }, () => getRandomItem(USER_AGENTS));
    } else if (data.length < count) {
      const needed = count - data.length;
      const extra = Array.from({ length: needed }, () =>
        getRandomItem(USER_AGENTS),
      );
      data = data.concat(extra);
    }

    if (data.length < count) {
      while (data.length < count) {
        data = data.concat(data.slice(0, count - data.length));
      }
    }
    return data.slice(0, count);
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
