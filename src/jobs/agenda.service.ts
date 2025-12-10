import { CRON_TASK_PROCESSOR, FIVE_MIN, JobPriority } from '@consts';
import { TaskStatus } from '@enums';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { JobWrapper, LogWrapper } from '@utils';
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

      await agenda.start();
      this.logger.info('Agenda started successfully');

      agenda.define(
        'processAllActiveTasks',
        {
          priority: JobPriority.low,
          lockLifetime: FIVE_MIN,
        },
        this.wrapJob('processAllActiveTasks', async () => {
          await this.processAllActiveTasks();
        }),
      );

      await this.scheduleJob(CRON_TASK_PROCESSOR, 'processAllActiveTasks');
      this.logger.info('Main job scheduled successfully');
    } catch (error) {
      this.logger.error('Failed to start agenda:', error);
    }
  }

  async processAllActiveTasks(): Promise<void> {
    try {
      const activeTasks = await this.taskModel
        .find({
          status: TaskStatus.ACTIVE,
          isRunning: false,
        })
        .exec();
  
      this.logger.info(`Found ${activeTasks.length} active tasks to process`);
  
      for (const task of activeTasks) {
        this.logger.debug(`[Agenda] Starting loop for task ${task._id}`);
        this.taskProcessorService.processTasks(task._id.toString()).catch((e) => {
          this.logger.error(`Error processing task ${task._id}: ${e.message}`);
        });
      }
    } catch (error) {
      this.logger.error(`Error processing active tasks: ${error.message}`, error);
    }
  }

  private async scheduleJob(cronExpression: string, jobName: string) {
    await agenda.every(cronExpression, jobName);
    const jobs = await agenda.jobs({ name: jobName });
    const nextRunAt = jobs.length > 0 ? jobs[0].attrs.nextRunAt : 'NOT SCHEDULED!!!!!';
    this.logger.info(`Scheduled "${jobName}" job: "${cronExpression}". Next run at: ${nextRunAt}`);
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

  private wrapJob(name: string, handler: (job) => Promise<void>) {
    return async (job) => {
      await new JobWrapper(name, handler).execute(job);
    };
  }
}
