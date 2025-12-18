import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Model } from 'mongoose';

import { TaskStatus } from '../enums';
import { Task } from '../task/task.schema';
import { calculateMaxConcurrentTasks } from '../utils/concurrency-limits';
import { LogWrapper } from '../utils/LogWrapper';
import { TaskProcessorService } from './task-processor.service';

const JOB_NAME = 'process-task-loop';

interface TaskJobData {
  taskId: string;
}

@Injectable()
export class BullMQService implements OnModuleDestroy {
  private readonly logger = new LogWrapper(BullMQService.name);
  private redis: Redis;
  private taskQueue: Queue;
  private worker: Worker;
  private isInitialized = false;
  private readonly MAX_CONCURRENT_TASKS: number = calculateMaxConcurrentTasks();

  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    private readonly taskProcessorService: TaskProcessorService,
  ) {}

  async onModuleInit() {
    await this.initialize();
  }

  async onModuleDestroy() {
    await this.cleanup();
  }

  private async initialize() {
    try {
      // TODO: use Singleton pattern for Redis connection in Redis service
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
      });

      this.taskQueue = new Queue('task-queue', {
        connection: this.redis,
        defaultJobOptions: {
          removeOnComplete: 9999,
          removeOnFail: 100,
          attempts: 1,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      });

      this.worker = new Worker(
        'task-queue',
        async (job: Job<TaskJobData>) => {
          await this.processTaskJob(job);
        },
        {
          connection: this.redis,
          concurrency: this.MAX_CONCURRENT_TASKS,
        },
      );

      this.worker.on('completed', (job) => {
        this.logger.info(`[WORKER] Задача ${job.data.taskId} завершена успешно`);
      });

      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `[WORKER] Задача ${job?.data.taskId} завершена с ошибкой: ${err.message}`,
        );
      });

      this.worker.on('error', (err) => {
        this.logger.error(`[WORKER] Ошибка воркера: ${err.message}`);
      });

      this.isInitialized = true;
      this.logger.info('[BULLMQ] Сервис инициализирован успешно');

      await this.taskModel.updateMany({ isRunning: true }, { isRunning: false }).exec();
      this.logger.info('[BULLMQ] Reset task locks on startup');

      await this.scheduleActiveTasks();
    } catch (error) {
      this.logger.error(`[BULLMQ] Ошибка инициализации: ${error.message}`);
      throw error;
    }
  }

  private async cleanup() {
    try {
      if (this.worker) {
        await this.worker.close();
      }
      if (this.taskQueue) {
        await this.taskQueue.close();
      }
      if (this.redis) {
        await this.redis.quit();
      }
      this.logger.info('[BULLMQ] Сервис остановлен');
    } catch (error) {
      this.logger.error(`[BULLMQ] Ошибка при остановке: ${error.message}`);
    }
  }

  private jobId(taskId: string) {
    return `task-loop-${taskId}`;
  }

  async enqueueTaskLoop(taskId: string): Promise<void> {
    if (!this.isInitialized) throw new Error('BullMQ service not initialized');
  
    const task = await this.taskModel.findById(taskId).select('status isRunning').exec();
    if (!task) throw new Error(`Task ${taskId} not found`);
  
    if (task.status !== TaskStatus.ACTIVE) {
      this.logger.warn(`[ENQUEUE] Task ${taskId} is not active, skipping`);
      return;
    }
  
    const id = this.jobId(taskId);
  
    const existing = await this.taskQueue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      this.logger.info(`[ENQUEUE] Found existing loop job for ${taskId} in state=${state}`);
  
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
        this.logger.info(`[ENQUEUE] Removed stale loop job for ${taskId} (state=${state})`);
      } else {
        return;
      }
    }
  
    await this.taskQueue.add(
      JOB_NAME,
      { taskId },
      {
        jobId: id,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 1,
      },
    );
  
    this.logger.info(`[ENQUEUE] Enqueued loop job for ${taskId}`);
  }

  async cancelTask(taskId: string): Promise<void> {
    if (!this.isInitialized) throw new Error('BullMQ service not initialized');
  
    const job = await this.taskQueue.getJob(this.jobId(taskId));
    if (!job) {
      this.logger.info(`[CANCEL] No loop job found for task ${taskId}`);
      return;
    }
  
    await job.remove();
    this.logger.info(`[CANCEL] Removed loop job for task ${taskId}`);
  }

  async rescheduleTask(taskId: string): Promise<void> {
    await this.cancelTask(taskId);
    await this.enqueueTaskLoop(taskId);
  }

  private async processTaskJob(job: Job<TaskJobData>): Promise<void> {
    const { taskId } = job.data;
  
    this.logger.info(`[PROCESS_LOOP] Starting loop for task ${taskId}`);
  
    const task = await this.taskModel.findById(taskId).select('status').exec();
    if (!task) {
      this.logger.warn(`[PROCESS_LOOP] Task ${taskId} not found, skipping`);
      return;
    }
  
    if (task.status !== TaskStatus.ACTIVE) {
      this.logger.warn(`[PROCESS_LOOP] Task ${taskId} is not active (status: ${task.status}), skipping`);
      return;
    }
  
    await this.taskProcessorService.processTasks(taskId);
  
    this.logger.info(`[PROCESS_LOOP] Finished loop for task ${taskId}`);
  }

  private async scheduleActiveTasks(): Promise<void> {
    try {
      const activeTasks = await this.taskModel
        .find({ status: TaskStatus.ACTIVE })
        .select('_id')
        .exec();
  
      this.logger.info(`[SCHEDULE_ACTIVE] Found ${activeTasks.length} active tasks to enqueue`);
  
      for (const t of activeTasks) {
        try {
          await this.enqueueTaskLoop(t._id.toString());
        } catch (e: any) {
          this.logger.error(`[SCHEDULE_ACTIVE] Error enqueuing task ${t._id}: ${e.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[SCHEDULE_ACTIVE] Error: ${e.message}`);
    }
  }

  async getQueueStats() {
    if (!this.isInitialized) {
      throw new Error('BullMQ service not initialized');
    }

    try {
      const waiting = await this.taskQueue.getWaiting();
      const active = await this.taskQueue.getActive();
      const completed = await this.taskQueue.getCompleted();
      const failed = await this.taskQueue.getFailed();
      const delayed = await this.taskQueue.getDelayed();

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
        total: waiting.length + active.length + delayed.length,
        maxConcurrentTasks: this.MAX_CONCURRENT_TASKS,
        concurrencyLimit: this.MAX_CONCURRENT_TASKS,
      };
    } catch (error) {
      this.logger.error(`[STATS] Error getting queue stats: ${error.message}`);
      throw error;
    }
  }

  async getScheduledTasks(): Promise<
    Array<{ taskId: string; jobId: string; delay: number; priority: number }>
  > {
    if (!this.isInitialized) {
      throw new Error('BullMQ service not initialized');
    }

    try {
      const delayed = await this.taskQueue.getDelayed();
      const waiting = await this.taskQueue.getWaiting();

      const scheduledTasks = [...delayed, ...waiting].map((job) => ({
        taskId: job.data.taskId,
        jobId: job.id,
        delay: job.delay || 0,
        priority: job.opts.priority || 0,
        scheduledAt: job.timestamp,
        nextRunAt: new Date(job.timestamp + (job.delay || 0)),
      }));

      return scheduledTasks;
    } catch (error) {
      this.logger.error(`[SCHEDULED_TASKS] Error getting scheduled tasks: ${error.message}`);
      throw error;
    }
  }

  async clearQueue() {
    // TODO: seperate method
    if (!this.isInitialized) {
      throw new Error('BullMQ service not initialized');
    }

    try {
      await this.taskQueue.obliterate();
      this.logger.info('[CLEAR] Queue cleared successfully');
    } catch (error) {
      this.logger.error(`[CLEAR] Error clearing queue: ${error.message}`);
      throw error;
    }
  }
}
