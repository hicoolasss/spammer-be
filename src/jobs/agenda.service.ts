import {
  CRON_TASK_PROCESSOR,
  FIVE_MIN,
  JOB_TASK_PROCESSOR,
  JobPriority,
} from '@consts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobWrapper, LogWrapper } from '@utils';
import { PuppeteerService } from 'src/puppeteer/puppeteer.service';

import agenda from './agendaInstance';
import { TaskProcessorService } from './task-processor.service';

@Injectable()
export class AgendaService implements OnModuleInit {
  private readonly logger = new LogWrapper(AgendaService.name);

  constructor(
    private readonly puppeteerService: PuppeteerService,
    private readonly taskProcessorService: TaskProcessorService,
  ) {}

  async onModuleInit() {
    agenda.define(
      JOB_TASK_PROCESSOR,
      {
        priority: JobPriority.low,
        lockLifetime: FIVE_MIN,
      },
      this.wrapJob(JOB_TASK_PROCESSOR, async () => {
        await this.taskProcessorService.processRandomTask();
      }),
    );

    try {
      await agenda.start();
      this.logger.info('Agenda started');

      await this.scheduleJob(CRON_TASK_PROCESSOR, JOB_TASK_PROCESSOR);
    } catch (error) {
      this.logger.error('Failed to start Agenda', error);
    }
  }

  private async scheduleJob(cronExpression: string, jobName: string) {
    await agenda.every(cronExpression, jobName);
    const jobs = await agenda.jobs({ name: jobName });
    const nextRunAt =
      jobs.length > 0 ? jobs[0].attrs.nextRunAt : 'NOT SCHEDULED!!!!!';
    this.logger.info(
      `Scheduled "${jobName}" job: "${cronExpression}". Next run at: ${nextRunAt}`,
    );
  }

  private wrapJob(name: string, handler: (job) => Promise<void>) {
    return async (job) => {
      await new JobWrapper(name, handler).execute(job);
    };
  }
}
