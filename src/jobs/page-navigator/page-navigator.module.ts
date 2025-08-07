import { Module } from '@nestjs/common';

import { PageNavigatorService } from './page-navigator.service';

@Module({
  providers: [PageNavigatorService],
  exports: [PageNavigatorService],
})
export class PageNavigatorModule {} 