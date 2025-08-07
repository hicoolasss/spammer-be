import { CountryCode } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { LogWrapper, TaskLogger } from '@utils';
import { Model } from 'mongoose';
import { Page } from 'puppeteer';

import { AIService } from '../../ai/ai.service';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';
import { RedisService } from '../../redis/redis.service';
import { FormFillerService } from '../form-filler/form-filler.service';
import { PageNavigatorService } from '../page-navigator/page-navigator.service';
import { TaskStatisticsService } from '../task-statistics/task-statistics.service';

export interface TaskExecutionContext {
  task: TaskDocument;
  leadData: LeadData;
  userAgent: string;
  finalUrl: string;
  geo: CountryCode;
}

@Injectable()
export class TaskExecutorService {
  private readonly logger = new LogWrapper(TaskExecutorService.name);

  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    @InjectModel(GeoProfile.name) private geoProfileModel: Model<GeoProfile>,
    private readonly puppeteerService: PuppeteerService,
    private readonly redisService: RedisService,
    private readonly aiService: AIService,
    private readonly formFillerService: FormFillerService,
    private readonly pageNavigatorService: PageNavigatorService,
    private readonly taskStatisticsService: TaskStatisticsService,
  ) {}

  async executeTask(taskId: string): Promise<void> {
    const taskLogger = new TaskLogger(TaskExecutorService.name, taskId);
    taskLogger.info('🚀 Starting task execution');

    const task = await this.loadAndValidateTask(taskId, taskLogger);
    if (!task) return;

    const context = await this.prepareTaskContext(task, taskLogger);
    if (!context) return;

    await this.runTaskWithRetry(context, taskLogger);
  }

  private async loadAndValidateTask(taskId: string, taskLogger: TaskLogger): Promise<TaskDocument | null> {
    const task = await this.taskModel.findById(taskId).exec();
    
    if (!task) {
      taskLogger.error('Task not found');
      return null;
    }

    if (task.isRunning) {
      taskLogger.warn('Task is already running, skipping');
      return null;
    }

    return task;
  }

  private async prepareTaskContext(task: TaskDocument, taskLogger: TaskLogger): Promise<TaskExecutionContext | null> {
    const { _id, url, profileId, geo } = task;
    const taskId = _id.toString();

    const profile = await this.geoProfileModel.findById(profileId).exec();
    if (!profile) {
      taskLogger.error(`Profile ${profileId} not found for task`);
      return null;
    }

    const { leadKey, fbclidKey, userAgentKey } = profile;
    
    const redisData = await this.loadRedisData(leadKey, userAgentKey, fbclidKey, taskId, taskLogger);
    if (!redisData) return null;

    const finalUrl = this.buildFinalUrl(url, redisData.fbclid);

    return {
      task,
      leadData: redisData.leadData,
      userAgent: redisData.userAgent,
      finalUrl,
      geo: geo as CountryCode,
    };
  }

  private async loadRedisData(
    leadKey: string, 
    userAgentKey: string, 
    fbclidKey: string, 
    taskId: string,
    taskLogger: TaskLogger
  ) {
    try {
      const [leadData, userAgent, fbclid] = await Promise.all([
        this.redisService.getLeadData(leadKey),
        this.redisService.getUserAgentData(userAgentKey),
        this.redisService.getFbclidData(fbclidKey),
      ]);

      if (!leadData) {
        taskLogger.warn(`Lead data not found for key: ${leadKey}`);
        return null;
      }

      if (!userAgent) {
        taskLogger.warn(`User agent not found for key: ${userAgentKey}`);
        return null;
      }

      return { leadData, userAgent, fbclid };
    } catch (error) {
      taskLogger.warn(`Redis data not available: ${error.message}`);
      return null;
    }
  }

  private buildFinalUrl(baseUrl: string, fbclid: string | null): string {
    if (!fbclid) return baseUrl;
    
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}fbclid=${fbclid}`;
  }

  private async runTaskWithRetry(context: TaskExecutionContext, taskLogger: TaskLogger): Promise<void> {
    const { task } = context;
    const taskId = task._id.toString();

    task.isRunning = true;
    await task.save();

    try {
      await this.executePuppeteerTask(context, taskLogger);
      await this.updateTaskLastRun(taskId);
      taskLogger.info('✅ Task completed successfully');
    } catch (error) {
      taskLogger.error(`❌ Task failed: ${error.message}`);
      throw error;
    } finally {
      task.isRunning = false;
      await task.save();
    }
  }

  private async executePuppeteerTask(context: TaskExecutionContext, taskLogger: TaskLogger): Promise<void> {
    const { task, leadData, userAgent, finalUrl, geo } = context;
    const taskId = task._id.toString();

    let page: Page | null = null;
    let finalRedirectUrl: string | null = null;
    let visitedUrls: string[] = [];
    let success = true;
    let error: string | undefined;

    try {
      page = await this.acquirePageWithRetry(geo, userAgent, taskId, taskLogger);
      
      const navigationResult = await this.pageNavigatorService.navigateToTarget(
        page, 
        finalUrl, 
        task.shouldClickRedirectLink,
        taskId
      );
      
      visitedUrls = navigationResult.visitedUrls;
      finalRedirectUrl = navigationResult.finalUrl;

      await this.formFillerService.fillForm(page, leadData, task, geo, taskId);
      
      finalRedirectUrl = page.url();
    } catch ({message}) {
      success = false;
      taskLogger.error(`Task execution failed: ${message}`);
    } finally {
      if (page && !page.isClosed()) {
        await this.puppeteerService.releasePage(page, geo);
      }
      
      await this.taskStatisticsService.updateTaskStatistics(
        taskId,
        finalRedirectUrl,
        visitedUrls,
        success,
        error
      );
    }
  }

  private async acquirePageWithRetry(
    geo: CountryCode, 
    userAgent: string, 
    taskId: string,
    taskLogger: TaskLogger,
    maxRetries = 3
  ): Promise<Page> {
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        const page = await this.puppeteerService.acquirePage(geo, userAgent);
        taskLogger.info(`✅ Page acquired successfully on attempt ${retryCount + 1}`);
        return page;
      } catch (error) {
        retryCount++;
        taskLogger.warn(`⚠️ Failed to acquire page on attempt ${retryCount}: ${error.message}`);
        
        if (retryCount >= maxRetries) {
          throw new Error(`Failed to acquire page after ${maxRetries} attempts: ${error.message}`);
        }
        
        await this.sleep(1000 + Math.random() * 2000);
      }
    }
    
    throw new Error('Failed to acquire page after all retries');
  }

  private async updateTaskLastRun(taskId: string): Promise<void> {
    await this.taskModel.findByIdAndUpdate(taskId, { lastRunAt: new Date() });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
} 