import { AIService } from '@ai/ai.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { GeoRegions, GeoRegionsSchema } from './geo-regions.schema';
import { GeoRegionsService } from './geo-regions.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: GeoRegions.name, schema: GeoRegionsSchema }])],
  providers: [AIService, GeoRegionsService],
  exports: [GeoRegionsService, MongooseModule],
})
export class GeoRegionsModule {}
