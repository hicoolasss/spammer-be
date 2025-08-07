import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AIModule } from '../ai/ai.module';
import { GeoProfile, GeoProfileSchema } from '../geo-profile/geo-profile.schema';
import { Task, TaskSchema } from '../task/task.schema';
import { BullMQService } from './bullmq.service';
import { TaskProcessorService } from './task-processor.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    AIModule,
  ],
  providers: [BullMQService, TaskProcessorService],
  exports: [BullMQService, TaskProcessorService],
})
export class JobsModule {} 