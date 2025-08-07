import { Module } from '@nestjs/common';

import { TaskQueueManager } from './task-queue.manager';

@Module({
  providers: [TaskQueueManager],
  exports: [TaskQueueManager],
})
export class TaskQueueModule {} 