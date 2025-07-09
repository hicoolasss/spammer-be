import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PuppeteerService } from './puppeteer.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
  ],
  providers: [PuppeteerService],
  exports: [PuppeteerService],
})
export class PuppeteerModule {}
