import { Inject, Injectable } from '@nestjs/common';
import { CreateGeoProfileDto } from './dto/create-geo-profile.dto';
import { GeoProfileResponseDto } from './dto/geo-profile.dto';
import { Buffers } from '@interfaces';
import { Model } from 'mongoose';
import { GeoProfile } from './geo-profile.schema';
import { InjectModel } from '@nestjs/mongoose';
import { REDIS_CLIENT } from 'src/redis/redis.module';
import { RedisClientType } from 'redis';
import * as csv from 'csv-parser';
import { createReadStream, unlink } from 'fs';

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
  ): Promise<GeoProfileResponseDto> {
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

    await pipeline.exec();

    profile.leadCount = leadCount;
    profile.leadKey = leadsKey;
    profile.fbclidKey = fbclidKey;
    profile.userAgentKey = uasKey;
    await profile.save();

    [files.leadDataPath, files.userAgentsPath, files.fbClidsPath]
      .filter((p) => !!p)
      .forEach((p) => unlink(p, () => {}));

    return {
      id: profileId,
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

  async findAllByUser(userId: string): Promise<GeoProfileResponseDto[]> {
    const profiles = await this.profileModel.find({ createdBy: userId }).lean();
    return profiles.map((profile) => ({
      id: profile._id.toString(),
      name: profile.name,
      geo: profile.geo,
      leadKey: `leads:${profile._id}`,
      userAgentKey: `uas:${profile._id}`,
      fbclidKey: `fbcls:${profile._id}`,
      createdBy: profile.createdBy,
      createdAt: profile.createdAt,
      leadCount: profile.leadCount || 0,
      userAgentCount: profile.useAgentCount || 0,
      fbclidCount: profile.fbclidCount || 0,
    }));
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
