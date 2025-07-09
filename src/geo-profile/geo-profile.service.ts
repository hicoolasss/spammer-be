import { Buffers } from '@interfaces';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as csv from 'csv-parser';
import { createReadStream, unlink } from 'fs';
import { FilterQuery, Model } from 'mongoose';
import { RedisClientType } from 'redis';
import { REDIS_CLIENT } from 'src/redis/redis.module';

import { CreateGeoProfileDto } from './dto/create-geo-profile.dto';
import {
  GeoProfileDto,
  GeoProfileListResponseDto,
} from './dto/geo-profile.dto';
import { GeoProfile, GeoProfileDocument } from './geo-profile.schema';

@Injectable()
export class GeoProfileService {
  constructor(
    @InjectModel(GeoProfile.name) private profileModel: Model<GeoProfile>,
    @Inject(REDIS_CLIENT) private redisClient: RedisClientType,
  ) {}

  async createGeoProfile(
    dto: CreateGeoProfileDto,
    files: Buffers,
    userId: string,
  ): Promise<GeoProfileDto> {
    const profile = await this.profileModel.create({
      name: dto.name,
      geo: dto.geo,
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

    await this.parseCsvFile(
      files.leadDataPath,
      ['name', 'lastname', 'phone', 'email'],
      (row) => {
        pipeline.rPush(leadsKey, JSON.stringify(row));
        leadCount++;
      },
    );

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

    [files.leadDataPath, files.userAgentsPath, files.fbClidsPath]
      .filter((p) => !!p)
      .forEach((p) => unlink(p, () => {}));

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

  async deleteGeoProfile(profileId: string) {
    const profile = await this.profileModel.findById(profileId).exec();
    if (!profile) {
      throw new Error(`Profile with ID ${profileId} not found`);
    }

    const keysToDelete = [
      profile.leadKey,
      profile.userAgentKey,
      profile.fbclidKey,
    ].filter((k): k is string => typeof k === 'string');

    if (keysToDelete.length) {
      await Promise.all(keysToDelete.map((key) => this.redisClient.del(key)));
    }

    await this.profileModel.deleteOne({ _id: profileId }).exec();

    return;
  }

  private parseCsvFile(
    filePath: string,
    headers: string[],
    onRow: (row: Record<string, string>) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      createReadStream(filePath)
        .pipe(csv({ headers, skipLines: 0 }))
        .on('data', onRow)
        .on('end', resolve)
        .on('error', reject);
    });
  }
}
