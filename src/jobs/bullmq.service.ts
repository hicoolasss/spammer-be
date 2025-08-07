import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Model } from 'mongoose';

import { TaskStatus } from '../enums';
import { Task, TaskDocument } from '../task/task.schema';
import { calculateMaxConcurrentTasks } from '../utils/concurrency-limits';
import { LogWrapper } from '../utils/LogWrapper';
import { getTimeUntilNextAllowedRun, isWithinTimeRange } from '../utils/time-utils';
import { TaskProcessorService } from './task-processor.service';

interface TaskJobData {
  taskId: string;
  priority?: number;
  delay?: number;
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
          attempts: 15,
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

      await this.scheduleExistingTasks();
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

  async scheduleTask(taskId: string, intervalMinutes: number): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('BullMQ service not initialized');
    }

    try {
      const task = await this.taskModel.findById(taskId).exec();

      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.status !== TaskStatus.ACTIVE) {
        this.logger.warn(`[SCHEDULE] Task ${taskId} is not active, skipping`);
        return;
      }

      if (!isWithinTimeRange(task.timeFrom, task.timeTo)) {
        const timeUntilNextRun = getTimeUntilNextAllowedRun(task.timeFrom, task.timeTo);

        this.logger.info(
          `[SCHEDULE] Task ${taskId} is outside allowed time range (${task.timeFrom}-${task.timeTo}). ` +
            `Scheduling for next allowed time in ${Math.round(timeUntilNextRun / 1000 / 60)} minutes`,
        );

        await this.taskQueue.add(
          'process-task',
          { taskId },
          {
            delay: timeUntilNextRun + intervalMinutes * 60 * 1000,
            priority: 1,
            jobId: `task-${taskId}-${Date.now()}`,
            removeOnComplete: true,
            removeOnFail: false,
          },
        );

        const nextRunAt = new Date(Date.now() + timeUntilNextRun + intervalMinutes * 60 * 1000);
        await this.taskModel.findByIdAndUpdate(taskId, {
          nextRunAt,
          lastScheduledAt: new Date(),
        });

        return;
      }

      const now = new Date();
      const nextRunAt = new Date(now.getTime() + intervalMinutes * 60 * 1000);

      const randomDelay = Math.floor(Math.random() * 120) + 30; // Случайная задержка от 30 до 150 секунд
      const delayedRunAt = new Date(nextRunAt.getTime() + randomDelay * 1000);

      const priority = this.calculatePriority(task, intervalMinutes);

      await this.taskQueue.add(
        'process-task',
        { taskId },
        {
          delay: delayedRunAt.getTime() - now.getTime(),
          priority,
          jobId: `task-${taskId}-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      await this.taskModel.findByIdAndUpdate(taskId, {
        nextRunAt: delayedRunAt,
        lastScheduledAt: now,
      });

      this.logger.info(
        `[SCHEDULE] Task ${taskId} scheduled for ${delayedRunAt.toISOString()} with priority ${priority} ` +
          `(time range: ${task.timeFrom}-${task.timeTo})`,
      );
    } catch (error) {
      this.logger.error(`[SCHEDULE] Error scheduling task ${taskId}: ${error.message}`);
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('BullMQ service not initialized');
    }

    try {
      const jobs = await this.taskQueue.getJobs(['delayed', 'waiting']);
      const jobsToRemove = jobs.filter((job) => job.data.taskId === taskId);

      for (const job of jobsToRemove) {
        await job.remove();
      }

      this.logger.info(`[CANCEL] Cancelled ${jobsToRemove.length} jobs for task ${taskId}`);
    } catch (error) {
      this.logger.error(`[CANCEL] Error cancelling task ${taskId}: ${error.message}`);
      throw error;
    }
  }

  async rescheduleTask(taskId: string, intervalMinutes: number): Promise<void> {
    await this.cancelTask(taskId);
    await this.scheduleTask(taskId, intervalMinutes);
  }

  private async processTaskJob(job: Job<TaskJobData>): Promise<void> {
    const { taskId } = job.data;

    this.logger.info(`[PROCESS] Processing task ${taskId}`);

    try {
      const task = await this.taskModel.findById(taskId).exec();
      if (!task) {
        this.logger.warn(`[PROCESS] Task ${taskId} not found, skipping`);
        return;
      }

      if (task.status !== TaskStatus.ACTIVE) {
        this.logger.warn(
          `[PROCESS] Task ${taskId} is not active (status: ${task.status}), skipping`,
        );
        return;
      }

      if (task.isRunning) {
        this.logger.warn(`[PROCESS] Task ${taskId} is already running, skipping`);
        return;
      }

      if (!isWithinTimeRange(task.timeFrom, task.timeTo)) {
        this.logger.warn(
          `[PROCESS] Task ${taskId} is outside allowed time range (${task.timeFrom}-${task.timeTo}), skipping`,
        );

        const timeUntilNextRun = getTimeUntilNextAllowedRun(task.timeFrom, task.timeTo);
        await this.scheduleTask(taskId, timeUntilNextRun);
        return;
      }

      await this.taskProcessorService.processTasks(taskId);
      await this.taskModel.findByIdAndUpdate(taskId, {
        lastRunAt: new Date(),
        isRunning: false,
      });

      this.logger.info(`[PROCESS] Task ${taskId} processed successfully`);
    } catch (error) {
      this.logger.error(`[PROCESS] Error processing task ${taskId}: ${error.message}`);

      await this.taskModel.findByIdAndUpdate(taskId, {
        isRunning: false,
      });

      throw error;
    }
  }

  private async scheduleExistingTasks(): Promise<void> {
    try {
      const resetResult = await this.taskModel.updateMany(
        { isRunning: true },
        { isRunning: false },
      );

      if (resetResult.modifiedCount > 0) {
        this.logger.info(
          `[SCHEDULE_EXISTING] Reset isRunning to false for ${resetResult.modifiedCount} tasks`,
        );
      }

      const deleteResult = await this.taskModel.deleteMany({
        status: { $ne: TaskStatus.ACTIVE },
      });

      if (deleteResult.deletedCount > 0) {
        this.logger.info(`[SCHEDULE_EXISTING] Deleted ${deleteResult.deletedCount} inactive tasks`);
      }

      const activeTasks = await this.taskModel
        .find({
          status: TaskStatus.ACTIVE,
          isRunning: false,
        })
        .exec();

      this.logger.info(`[SCHEDULE_EXISTING] Found ${activeTasks.length} active tasks to schedule`);

      let scheduledCount = 0;
      let skippedCount = 0;

      for (const task of activeTasks) {
        try {
          if (isWithinTimeRange(task.timeFrom, task.timeTo)) {
            await this.scheduleTask(task._id.toString(), task.intervalMinutes);
            scheduledCount++;
          } else {
            this.logger.info(
              `[SCHEDULE_EXISTING] Task ${task._id} is outside allowed time range ` +
                `(${task.timeFrom}-${task.timeTo}), will be scheduled later`,
            );
            await this.scheduleTask(task._id.toString(), task.intervalMinutes);
            skippedCount++;
          }
        } catch (error) {
          this.logger.error(
            `[SCHEDULE_EXISTING] Error scheduling task ${task._id}: ${error.message}`,
          );
        }
      }

      this.logger.info(
        `[SCHEDULE_EXISTING] Finished scheduling existing tasks. ` +
          `Scheduled: ${scheduledCount}, Skipped (outside time): ${skippedCount}`,
      );
    } catch (error) {
      this.logger.error(`[SCHEDULE_EXISTING] Error scheduling existing tasks: ${error.message}`);
    }
  }

  private calculatePriority(task: TaskDocument, intervalMinutes: number): number {
    const now = new Date();
    const lastRunAt = task.lastRunAt ? new Date(task.lastRunAt) : new Date(0);
    const timeSinceLastRun = now.getTime() - lastRunAt.getTime();

    let priority = Math.floor(timeSinceLastRun / (intervalMinutes * 60 * 1000));
    priority += Math.floor(Math.random() * 10);

    return Math.min(Math.max(priority, 1), 100);
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
