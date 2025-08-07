import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from '@task/task.schema';

import { TaskStatisticsService } from './task-statistics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
    ]),
  ],
  providers: [TaskStatisticsService],
  exports: [TaskStatisticsService],
})
export class TaskStatisticsModule {} 