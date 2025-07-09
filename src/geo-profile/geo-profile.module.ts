import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RedisModule } from '../redis/redis.module';
import { GeoProfileController } from './geo-profile.controller';
import { GeoProfile, GeoProfileSchema } from './geo-profile.schema';
import { GeoProfileService } from './geo-profile.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    RedisModule,
  ],
  controllers: [GeoProfileController],
  providers: [GeoProfileService],
})
export class GeoProfileModule {}
