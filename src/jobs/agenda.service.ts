import { CRON_CLEANUP_OLD_JOBS, FIVE_MIN, JOB_CLEANUP_OLD_JOBS, JobPriority } from '@consts';
import { TaskStatus } from '@enums';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { JobWrapper, LogWrapper } from '@utils';
import { Job } from 'agenda';
import { Model } from 'mongoose';

import agenda from './agendaInstance';
import { TaskProcessorService } from './task-processor/task-processor.service';

@Injectable()
export class AgendaService implements OnModuleInit {
  private readonly logger = new LogWrapper(AgendaService.name);

  constructor(
    private readonly taskProcessorService: TaskProcessorService,
    @InjectModel(Task.name) private readonly taskModel: Model<Task>,
  ) {}

  async onModuleInit() {
    try {
      await this.resetAllTaskLocks();
      await this.resetLockedAgendaJobs();
      await this.cleanupOldJobs();
      await agenda.start();
      this.logger.info('Agenda started successfully');

      agenda.define(
        'runTask',
        {
          priority: JobPriority.normal,
          lockLifetime: FIVE_MIN,
        },
        this.wrapJob('runTask', async (job) => {
          const { taskId } = job.attrs.data;
          if (!taskId) {
            this.logger.error('[AgendaService] No taskId provided in job data');
            return;
          }
          this.logger.info(
            `[AgendaService] 🚀 Executing runTask for taskId=${taskId} at ${new Date().toISOString()}`,
          );

          await this.taskProcessorService.processTasks(taskId);

          const task = await this.taskModel.findById(taskId);
          if (task && task.status === TaskStatus.ACTIVE) {
            this.logger.info(`[AgendaService] 📅 Rescheduling task ${taskId} for next run`);
            await this.scheduleTaskJob(task);
          }
        }),
      );

      agenda.define(
        'cleanupOldJobs',
        {
          priority: JobPriority.highest,
          lockLifetime: FIVE_MIN,
        },
        this.wrapJob('cleanupOldJobs', async () => {
          await this.cleanupOldJobs();
        }),
      );

      await agenda.every(CRON_CLEANUP_OLD_JOBS, JOB_CLEANUP_OLD_JOBS);
      this.logger.info('Scheduled cleanup job every hour');

      const activeTasks = await this.taskModel.find({ status: TaskStatus.ACTIVE }).exec();
      for (const task of activeTasks) {
        await this.scheduleTaskJob(task);
      }
      this.logger.info(`Checked and scheduled ${activeTasks.length} dynamic jobs on startup`);
    } catch (error) {
      this.logger.error('Failed to start agenda:', error);
    }
  }

  private async resetAllTaskLocks(): Promise<void> {
    try {
      const result = await this.taskModel.updateMany({ isRunning: true }, { isRunning: false });
      this.logTaskLockReset(result.modifiedCount);
    } catch (error) {
      this.logger.error('Failed to reset task locks:', error);
    }
  }

  private async resetLockedAgendaJobs(): Promise<void> {
    try {
      const fiveMinutesAgo = new Date(Date.now() - FIVE_MIN);
      const lockedJobs = await agenda.jobs({
        name: 'runTask',
        lastRunAt: { $lt: fiveMinutesAgo },
        lastFinishedAt: { $exists: false },
      });

      if (lockedJobs.length > 0) {
        await agenda.cancel({ name: 'runTask', lastRunAt: { $lt: fiveMinutesAgo } });
        this.logger.info(`Reset ${lockedJobs.length} locked agenda jobs on startup`);
      }
    } catch (error) {
      this.logger.error('Failed to reset locked agenda jobs:', error);
    }
  }

  private wrapJob(name: string, handler: (job) => Promise<void>) {
    return async (job: Job) => {
      const jobWrapper = new JobWrapper(name, handler);
      await jobWrapper.execute(job);
    };
  }

  async scheduleTaskJob(task: TaskDocument) {
    const nextRun = this.calculateNextRun(task);
    if (nextRun) {
      await agenda.schedule(nextRun, 'runTask', { taskId: task._id.toString() });
    }
  }

  async cancelTaskJob(taskId: string) {
    await agenda.cancel({ name: 'runTask', 'data.taskId': taskId });
  }

  calculateNextRun(task: Task): Date | null {
    if (task.status !== TaskStatus.ACTIVE) {
      return null;
    }

    const now = new Date();
    const lastRun = task.lastRunAt || new Date(0);
    const intervalMs = (task.intervalMinutes || 1) * 60 * 1000;

    const nextRun = new Date(lastRun.getTime() + intervalMs);
    return nextRun > now ? nextRun : new Date(now.getTime() + intervalMs);
  }

  private async cleanupOldJobs(): Promise<void> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const oldJobs = await agenda.jobs({
        lastFinishedAt: { $lt: oneDayAgo },
        name: { $in: ['runTask', 'cleanupOldJobs'] },
      });

      if (oldJobs.length > 0) {
        await agenda.cancel({
          lastFinishedAt: { $lt: oneDayAgo },
          name: { $in: ['runTask', 'cleanupOldJobs'] },
        });

        this.logger.info(`Cleaned up ${oldJobs.length} old jobs`);
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old jobs:', error);
    }
  }

  private logTaskLockReset(modifiedCount: number): void {
    if (modifiedCount > 0) {
      this.logger.info(`Reset ${modifiedCount} task locks on startup`);
    } else {
      this.logger.info('No task locks to reset on startup');
    }
  }
}
