import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from '@task/task.schema';

import { PuppeteerModule } from '../puppeteer/puppeteer.module';
import { RedisServiceModule } from '../redis/redis-service.module';
import { AgendaService } from './agenda.service';
import { TaskProcessorService } from './task-processor.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    PuppeteerModule,
    RedisServiceModule,
  ],
  providers: [AgendaService, TaskProcessorService],
  exports: [AgendaService, TaskProcessorService],
})
export class JobsModule {}
