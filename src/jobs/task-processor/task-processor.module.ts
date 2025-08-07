import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from '@task/task.schema';

import { TaskExecutorModule } from '../task-executor/task-executor.module';
import { TaskQueueModule } from '../task-queue/task-queue.module';
import { TaskProcessorService } from './task-processor.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
    TaskQueueModule,
    TaskExecutorModule,
  ],
  providers: [TaskProcessorService],

  exports: [TaskProcessorService],
})
export class TaskProcessorModule {}
