import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { GeoRegionsModule } from '@geo-regions/geo-regions.module';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { DebugBrowserController } from './debug-browser.controller';
import { PuppeteerService } from './puppeteer.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    GeoRegionsModule,
  ],
  controllers: [DebugBrowserController],
  providers: [PuppeteerService],
  exports: [PuppeteerService],
})
export class PuppeteerModule {}
