import { CountryCode } from '@enums';
import { Buffers } from '@interfaces';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import csv from 'csv-parser';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { FilterQuery, Model } from 'mongoose';
import { RedisClientType } from 'redis';
import { REDIS_CLIENT } from 'src/redis/redis.module';
import { detectDelimiter } from 'src/utils/detect-delimiter';

import { CreateGeoProfileDto } from './dto/create-geo-profile.dto';
import { GeoProfileDto, GeoProfileListResponseDto } from './dto/geo-profile.dto';
import { GeoProfile, GeoProfileDocument } from './geo-profile.schema';

@Injectable()
export class GeoProfileService {
  private readonly logger = new Logger(GeoProfileService.name);

  constructor(
    @InjectModel(GeoProfile.name) private profileModel: Model<GeoProfile>,
    @Inject(REDIS_CLIENT) private redisClient: RedisClientType,
  ) {}

  async createGeoProfile(
    dto: CreateGeoProfileDto,
    files: Buffers,
    userId: string,
  ): Promise<GeoProfileDto> {
    const geo = Object.values(CountryCode).includes(dto.geo as CountryCode)
      ? dto.geo
      : CountryCode.ALL;
    if (geo === CountryCode.ALL && dto.geo !== CountryCode.ALL) {
      console.warn(`Geo '${dto.geo}' is not a valid CountryCode, using 'ALL'`);
    }
    const profile = await this.profileModel.create({
      name: dto.name,
      geo: geo,
      createdBy: userId,
      createdAt: new Date(),
    });
    const profileId = profile._id.toString();
    const leadsKey = `leads:${profileId}`;
    const uasKey = `uas:${profileId}`;
    const fbclidKey = `fbcls:${profileId}`;

    let leadCount = 0;
    let uaCount = 0;
    let fbclidCount = 0;

    const pipeline = this.redisClient.multi();

    await this.parseCsvFile(files.leadDataPath, ['name', 'lastname', 'email', 'phone'], (row) => {
      pipeline.rPush(leadsKey, JSON.stringify(row));
      leadCount++;
    });

    await this.parseCsvFile(files.userAgentsPath, ['userAgent'], (row) => {
      pipeline.rPush(uasKey, row.userAgent);
      uaCount++;
    });

    await this.parseCsvFile(files.fbClidsPath, ['fbclid'], (row) => {
      pipeline.rPush(fbclidKey, row.fbclid);
      fbclidCount++;
    });

    await pipeline.exec();

    profile.leadCount = leadCount;
    profile.useAgentCount = uaCount;
    profile.fbclidCount = fbclidCount;
    profile.leadKey = leadsKey;
    profile.fbclidKey = fbclidKey;
    profile.userAgentKey = uasKey;
    await profile.save();

    await Promise.all(
      [files.leadDataPath, files.userAgentsPath, files.fbClidsPath]
        .filter(Boolean)
        .map(async (p) => {
          try {
            await unlink(p);
          } catch (err) {
            this.logger.error(`Ошибка удаления файла ${p}:`, err);
          }
        })
    );

    return {
      _id: profileId,
      name: profile.name,
      geo: profile.geo,
      leadKey: leadsKey,
      userAgentKey: uasKey,
      fbclidKey: fbclidKey,
      createdBy: profile.createdBy,
      createdAt: profile.createdAt,
      leadCount,
      userAgentCount: uaCount,
      fbclidCount,
    };
  }

  async findAllByUser(
    userId: string,
    skip = 0,
    limit = 10,
    searchQuery?: string,
    selectedGeo?: string,
  ): Promise<GeoProfileListResponseDto> {
    const filter: FilterQuery<GeoProfileDocument> = { createdBy: userId };
    if (searchQuery) {
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escaped, $options: 'i' };
    }
    if (selectedGeo) {
      filter.geo = selectedGeo;
    }

    const total = await this.profileModel.countDocuments(filter).exec();
    let query = this.profileModel.find(filter).sort({ createdAt: -1 });

    if (skip > 0) {
      query = query.skip(skip);
    }
    if (limit > 0) {
      query = query.limit(limit);
    }

    const profiles = await query.lean().exec();

    const items = profiles.map((profile) => ({
      _id: profile._id.toString(),
      name: profile.name,
      geo: profile.geo,
      leadKey: profile.leadKey,
      userAgentKey: profile.userAgentKey,
      fbclidKey: profile.fbclidKey,
      createdBy: profile.createdBy,
      createdAt: profile.createdAt,
      leadCount: profile.leadCount || 0,
      userAgentCount: profile.useAgentCount || 0,
      fbclidCount: profile.fbclidCount || 0,
    }));

    return {
      items,
      total,
      hasMore: skip + profiles.length < total,
    };
  }

  async updateGeoProfile(
    profileId: string,
    dto: Partial<{ name: string; geo: string }>,
    files: {
      leadData?: Express.Multer.File[];
      fbclids?: Express.Multer.File[];
      userAgents?: Express.Multer.File[];
    },
  ): Promise<GeoProfileDto> {
    const profile = await this.profileModel.findById(profileId);
    if (!profile) throw new Error(`Profile with ID ${profileId} not found`);

    if (dto.name) profile.name = dto.name;
    if (dto.geo) profile.geo = dto.geo;

    if (files.leadData?.length) {
      profile.leadCount = await this.processCsvAndUpdateRedis(
        files.leadData[0].path,
        profile.leadKey,
        ['name', 'lastname', 'email', 'phone'],
        (row) => JSON.stringify(row),
      );
    }

    if (files.userAgents?.length) {
      profile.useAgentCount = await this.processCsvAndUpdateRedis(
        files.userAgents[0].path,
        profile.userAgentKey,
        ['userAgent'],
        (row) => row.userAgent,
      );
    }

    if (files.fbclids?.length) {
      profile.fbclidCount = await this.processCsvAndUpdateRedis(
        files.fbclids[0].path,
        profile.fbclidKey,
        ['fbclid'],
        (row) => row.fbclid,
      );
    }

    await profile.save();

    return {
      _id: profile._id.toString(),
      name: profile.name,
      geo: profile.geo,
      leadKey: profile.leadKey,
      userAgentKey: profile.userAgentKey,
      fbclidKey: profile.fbclidKey,
      createdBy: profile.createdBy,
      createdAt: profile.createdAt,
      leadCount: profile.leadCount,
      userAgentCount: profile.useAgentCount,
      fbclidCount: profile.fbclidCount,
    };
  }

  async deleteGeoProfile(profileId: string) {
    const profile = await this.profileModel.findById(profileId).exec();
    if (!profile) {
      throw new Error(`Profile with ID ${profileId} not found`);
    }

    const keysToDelete = [profile.leadKey, profile.userAgentKey, profile.fbclidKey].filter(
      (k): k is string => typeof k === 'string',
    );

    if (keysToDelete.length) {
      await Promise.all(keysToDelete.map((key) => this.redisClient.del(key)));
    }

    await this.profileModel.deleteOne({ _id: profileId }).exec();

    return;
  }

  private async parseCsvFile(
    filePath: string,
    headers: string[],
    onRow: (row: Record<string, string>) => void,
  ): Promise<void> {
    const separator = await detectDelimiter(filePath);
  
    return new Promise((resolve, reject) => {
      createReadStream(filePath)
        .pipe(csv({ headers, skipLines: 0, separator }))
        .on('data', onRow)
        .on('end', resolve)
        .on('error', reject);
    });
  }

  async processCsvAndUpdateRedis(
    filePath: string,
    redisKey: string,
    headers: string[],
    onRowTransform: (row: Record<string, string>) => string,
  ): Promise<number> {
    let count = 0;

    const pipeline = this.redisClient.multi();
    pipeline.del(redisKey);

    await this.parseCsvFile(filePath, headers, (row) => {
      pipeline.rPush(redisKey, onRowTransform(row));
      count++;
    });

    await pipeline.exec();

    await unlink(filePath);

    return count;
  }
}
