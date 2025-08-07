import { TaskStatus } from '@enums';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { LogWrapper } from '@utils';
import { Model } from 'mongoose';

import { TaskExecutorService } from '../task-executor/task-executor.service';
import { TaskQueueManager } from '../task-queue/task-queue.manager';

@Injectable()
export class TaskProcessorService {
  private readonly logger = new LogWrapper(TaskProcessorService.name);
  private processingLock: Promise<void> | null = null;

  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    private readonly taskQueueManager: TaskQueueManager,
    private readonly taskExecutorService: TaskExecutorService,
  ) {}

  async processAllActiveTasks(): Promise<void> {
    try {
      await this.acquireProcessingLock();
      
      const activeTasks = await this.loadActiveTasks();
      
      if (activeTasks.length === 0) {
        this.logger.info('No active tasks found');
        return;
      }

      this.addTasksToQueue(activeTasks);
      await this.startQueueProcessing();
    } catch (error) {
      this.logger.error(`Error processing active tasks: ${error.message}`, error);
    }
  }

  async processTasks(taskId: string): Promise<void> {
    this.logger.info(`🚀 Processing single task: ${taskId}`);
    await this.taskExecutorService.executeTask(taskId);
  }

  async getQueueStatistics() {
    return this.taskQueueManager.getQueueStatistics();
  }

  async forceProcessQueue(): Promise<void> {
    this.logger.info('🔄 Force processing queue...');
    if (!this.taskQueueManager.isCurrentlyProcessing()) {
      await this.startQueueProcessing();
    }
  }

  async getProcessingStatus() {
    const queueStats = this.taskQueueManager.getQueueStatistics();
    return {
      isProcessing: this.taskQueueManager.isCurrentlyProcessing(),
      queueStats,
      processingLock: this.processingLock !== null,
    };
  }

  private async acquireProcessingLock(): Promise<void> {
    if (this.processingLock) {
      this.logger.debug(`⏳ Waiting for processing lock...`);
      await this.processingLock;
    }
    
    this.processingLock = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.processingLock = null;
        resolve();
      }, 100);
    });
  }

  private async loadActiveTasks(): Promise<TaskDocument[]> {
    const activeTasks = await this.taskModel.find({ status: TaskStatus.ACTIVE }).exec();
    this.logger.info(`📋 Found ${activeTasks.length} active tasks to process`);
    return activeTasks;
  }

  private addTasksToQueue(tasks: TaskDocument[]): void {
    for (const task of tasks) {
      this.taskQueueManager.addTaskToQueue(task._id.toString(), 1);
    }
    this.logger.info(`📋 Added ${tasks.length} tasks to queue`);
  }

  private async startQueueProcessing(): Promise<void> {
    if (this.taskQueueManager.isCurrentlyProcessing()) {
      this.logger.debug('Queue is already being processed');
      return;
    }

    this.taskQueueManager.setProcessingStatus(true);
    this.logger.info('🚀 Starting sequential queue processing...');

    try {
      await this.processQueueSequentially();
      this.logger.info('✅ Queue processing completed');
    } catch (error) {
      this.logger.error(`Error in queue processing: ${error.message}`, error);
    } finally {
      this.taskQueueManager.setProcessingStatus(false);
    }
  }

  private async processQueueSequentially(): Promise<void> {
    while (!this.taskQueueManager.isQueueEmpty()) {
      const taskItem = this.taskQueueManager.getNextTask();
      
      if (taskItem) {
        await this.processSingleTask(taskItem);
        await this.addDelayBetweenTasks();
      }
    }
  }

  private async processSingleTask(taskItem: { taskId: string; priority: number }): Promise<void> {
    const { taskId } = taskItem;
    const remainingTasks = this.taskQueueManager.getQueueLength();
    
    this.logger.info(`🚀 Processing task ${taskId} (queue: ${remainingTasks} remaining)`);

    try {
      await this.taskExecutorService.executeTask(taskId);
      this.logger.info(`✅ Task ${taskId} completed successfully`);
    } catch (error) {
      this.logger.error(`❌ Task ${taskId} failed: ${error.message}`);
    }
  }

  private async addDelayBetweenTasks(): Promise<void> {
    if (!this.taskQueueManager.isQueueEmpty()) {
      const delay = Math.floor(Math.random() * 3000) + 2000;
      this.logger.debug(`⏳ Waiting ${delay}ms before next task...`);
      await this.sleep(delay);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
} 