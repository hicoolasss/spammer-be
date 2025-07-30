import { CRON_CLEANUP_OLD_JOBS, FIVE_MIN, JOB_CLEANUP_OLD_JOBS, JobPriority } from '@consts';
import { TaskStatus } from '@enums';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { JobWrapper, LogWrapper } from '@utils';
import { Job } from 'agenda';
import { Model } from 'mongoose';

import agenda from './agendaInstance';
import { TaskProcessorService } from './task-processor.service';

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
          priority: JobPriority.high,
          lockLifetime: FIVE_MIN,
        },
        this.wrapJob('runTask', async (job: Job) => {
          const { taskId } = job.attrs.data as { taskId: string };
          if (!taskId) {
            this.logger.error('runTask job: taskId is missing in job data');
            return;
          }
          await this.taskProcessorService.processTasks(taskId);
          const task = await this.taskModel.findById(taskId);
          if (task && task.status === TaskStatus.ACTIVE) {
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

      if (result.modifiedCount > 0) {
        this.logger.info(`Reset ${result.modifiedCount} task locks on server startup`);
      } else {
        this.logger.info('No task locks found to reset');
      }
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
        lastFinishedAt: { $exists: false }
      });
      
      if (lockedJobs.length > 0) {
        await agenda.cancel({ name: 'runTask', lastRunAt: { $lt: fiveMinutesAgo } });
        this.logger.info(`Reset ${lockedJobs.length} locked agenda jobs on startup`);
      } else {
        this.logger.info('No locked agenda jobs found to reset');
      }
    } catch (error) {
      this.logger.error('Failed to reset locked agenda jobs:', error);
    }
  }

  private wrapJob(name: string, handler: (job) => Promise<void>) {
    return async (job) => {
      await new JobWrapper(name, handler).execute(job);
    };
  }

  async scheduleTaskJob(task: Task) {
    const taskId = (task as any)._id;
    await this.cancelTaskJob(taskId.toString());
    if (task.status !== TaskStatus.ACTIVE) return;
    const nextRun = this.calculateNextRun(task);
    if (!nextRun) return;
    await agenda.schedule(nextRun, 'runTask', { taskId: taskId.toString() });
    this.logger.info(`Scheduled runTask for task ${taskId} at ${nextRun}`);
  }

  async cancelTaskJob(taskId: string) {
    const num = await agenda.cancel({ name: 'runTask', 'data.taskId': taskId });
    this.logger.info(`Cancelled ${num} jobs for task ${taskId}`);
  }

  calculateNextRun(task: Task): Date | null {
    const now = new Date();
    const [fromHour, fromMin] = task.timeFrom.split(':').map(Number);
    const [toHour, toMin] = task.timeTo.split(':').map(Number);
    const timeFrom = new Date(now);
    timeFrom.setHours(fromHour, fromMin, 0, 0);
    const timeTo = new Date(now);
    timeTo.setHours(toHour, toMin, 0, 0);
    const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : null;
    let nextRun: Date;
    if (lastRun) {
      nextRun = new Date(lastRun.getTime() + (task.intervalMinutes || 1) * 60 * 1000);
    } else {
      nextRun = timeFrom;
    }
    if (nextRun >= timeFrom && nextRun <= timeTo && nextRun > now) {
      return nextRun;
    }
    if (now > timeTo) {
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      tomorrow.setHours(fromHour, fromMin, 0, 0);
      return tomorrow;
    }
    
    if (nextRun <= now) {
      const soon = new Date(now.getTime() + 1 * 60 * 1000);
      if (soon >= timeFrom && soon <= timeTo) return soon;
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      tomorrow.setHours(fromHour, fromMin, 0, 0);
      return tomorrow;
    }
    return null;
  }

  private async cleanupOldJobs(): Promise<void> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const failedJobs = await agenda.jobs({
        name: 'runTask',
        lastFinishedAt: { $lt: oneDayAgo },
        failedAt: { $exists: true }
      });
      
      if (failedJobs.length > 0) {
        await agenda.cancel({
          name: 'runTask',
          lastFinishedAt: { $lt: oneDayAgo },
          failedAt: { $exists: true }
        });
        this.logger.info(`Cleaned up ${failedJobs.length} old failed jobs`);
      }
      
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const completedJobs = await agenda.jobs({
        name: 'runTask',
        lastFinishedAt: { $lt: sevenDaysAgo },
        failedAt: { $exists: false }
      });
      
      if (completedJobs.length > 0) {
        await agenda.cancel({
          name: 'runTask',
          lastFinishedAt: { $lt: sevenDaysAgo },
          failedAt: { $exists: false }
        });
        this.logger.info(`Cleaned up ${completedJobs.length} old completed jobs`);
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old jobs:', error);
    }
  }
}
