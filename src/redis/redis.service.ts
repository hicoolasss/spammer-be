import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { getRandomItem, LogWrapper, USER_AGENTS } from '@utils';
import { RedisClientType } from 'redis';

@Injectable()
export class RedisService {
  private readonly logger = new LogWrapper(RedisService.name);

  constructor(private redisClient: RedisClientType) {}

  async getFbclidData(fbclKey: string): Promise<string> {
    return this.getRandomListItem<string>(
      fbclKey,
      undefined,
      `No fbcl data found for key: ${fbclKey}`,
    );
  }

  async getLeadData(leadKey: string): Promise<LeadData> {
    return this.getRandomListItem<LeadData>(
      leadKey,
      (v) => JSON.parse(v) as LeadData,
      `No data found for key: ${leadKey}`,
    );
  }

  async getUserAgentData(userAgentKey: string): Promise<string> {
    return this.getRandomListItem<string>(
      userAgentKey,
      undefined,
      `No user agents found for key: ${userAgentKey}, using fallback`,
      () => getRandomItem(USER_AGENTS),
    );
  }

  private async getRandomListItem<T = string>(
    key: string,
    parser?: (v: string) => T,
    notFoundMsg?: string,
    fallback?: () => T,
  ): Promise<T> {
    const len = await this.redisClient.lLen(key);

    if (!len || len === 0) {
      const msg = notFoundMsg || `No data found for key: ${key}`;
      this.logger.error(msg);
      if (fallback) return fallback();
      throw new Error(msg);
    }

    const randomIndex = Math.floor(Math.random() * len);
    const data = await this.redisClient.lIndex(key, randomIndex);

    if (data === null) {
      const msg = `No data found at index ${randomIndex} for key: ${key}`;
      this.logger.error(msg);
      if (fallback) return fallback();
      throw new Error(msg);
    }

    this.logger.info(`Retrieved data from ${key}: ${data}`);
    return parser ? parser(data as string) : (data as T);
  }
}
