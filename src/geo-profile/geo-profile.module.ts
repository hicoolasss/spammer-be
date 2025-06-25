import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { GeoProfileController } from './geo-profile.controller';
import { GeoProfileService } from './geo-profile.service';
import { GeoProfileSchema, GeoProfile } from './geo-profile.schema';
import { RedisModule } from '../redis/redis.module';

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
