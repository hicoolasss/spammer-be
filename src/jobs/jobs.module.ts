import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from '@task/task.schema';

import { AIModule } from '../ai/ai.module';
import { PuppeteerModule } from '../puppeteer/puppeteer.module';
import { AgendaService } from './agenda.service';
import { TaskProcessorService } from './task-processor.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    PuppeteerModule,
    AIModule,
  ],
  providers: [AgendaService, TaskProcessorService],
  exports: [AgendaService, TaskProcessorService],
})
export class JobsModule {}
