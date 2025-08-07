import { Module } from '@nestjs/common';

import { BrowserPoolModule } from './browser-pool/browser-pool.module';
import { PuppeteerService } from './puppeteer.service';

@Module({
  imports: [BrowserPoolModule],
  providers: [PuppeteerService],
  exports: [PuppeteerService],
})
export class PuppeteerModule {}
