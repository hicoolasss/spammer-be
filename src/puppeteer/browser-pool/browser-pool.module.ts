import { Module } from '@nestjs/common';

import { BrowserPoolManager } from './browser-pool.manager';

@Module({
  providers: [BrowserPoolManager],
  exports: [BrowserPoolManager],
})
export class BrowserPoolModule {} 