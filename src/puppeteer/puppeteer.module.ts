import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { GeoRegionsModule } from '@geo-regions/geo-regions.module';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PuppeteerService } from './puppeteer.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    GeoRegionsModule,
  ],
  providers: [PuppeteerService],
  exports: [PuppeteerService],
})
export class PuppeteerModule {}
