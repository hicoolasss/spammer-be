import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from '@task/task.schema';

import { AIModule } from '../../ai/ai.module';
import { PuppeteerModule } from '../../puppeteer/puppeteer.module';
import { RedisModule } from '../../redis/redis.module';
import { FormFillerModule } from '../form-filler/form-filler.module';
import { PageNavigatorModule } from '../page-navigator/page-navigator.module';
import { TaskStatisticsModule } from '../task-statistics/task-statistics.module';
import { TaskExecutorService } from './task-executor.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    PuppeteerModule,
    RedisModule,
    AIModule,
    FormFillerModule,
    PageNavigatorModule,
    TaskStatisticsModule,
  ],
  providers: [TaskExecutorService],
  exports: [TaskExecutorService],
})
export class TaskExecutorModule {} 