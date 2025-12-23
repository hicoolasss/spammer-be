import { AIService } from '@ai/ai.service';
import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskController } from '@task/task.controller';
import { Task, TaskSchema } from '@task/task.schema';
import { TaskService } from '@task/task.service';
import { TaskProcessorService } from 'src/jobs/task-processor.service';

import { BullMQService } from '../jobs/bullmq.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    RedisModule,
  ],
  controllers: [TaskController],
  providers: [AIService, TaskService, BullMQService, TaskProcessorService],
})
export class TaskModule {}
