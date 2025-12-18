import { CountryCode, TaskStatus } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { generateFbclid, generateLeadForGeo, getRandomDefaultUserAgent, IS_DEBUG_MODE, LogWrapper } from '@utils';
import * as fs from 'fs';
import { Model } from 'mongoose';
import * as path from 'path';
import { Browser, Page } from 'puppeteer';

import { AIService } from '../ai/ai.service';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { RedisService } from '../redis/redis.service';
import { calculateMaxConcurrentTasks } from '../utils/concurrency-limits';

const NAVIGATION_TIMEOUT_MS = 15_000;
const FORM_SUBMISSION_WAIT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        onTimeout();
        reject(new Error('Task timed out'));
      }, ms),
    ),
  ]);
}

interface QueuedTask {
  taskId: string;
  resolve: (value: void) => void;
  reject: (reason?: any) => void;
  priority: number;
}

@Injectable()
export class TaskProcessorService {
  private readonly logger = new LogWrapper(TaskProcessorService.name);
  private taskQueue: QueuedTask[] = [];
  private isProcessing = false;
  private readonly MAX_CONCURRENT_TASKS: number;
  private currentRunningTasks = 0;

  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    @InjectModel(GeoProfile.name) private geoProfileModel: Model<GeoProfile>,
    private readonly puppeteerService: PuppeteerService,
    private readonly redisService: RedisService,
    private readonly aiService: AIService,
  ) {
    this.MAX_CONCURRENT_TASKS = calculateMaxConcurrentTasks();
  }

  async processTasks(taskId: string): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      if (this.currentRunningTasks < this.MAX_CONCURRENT_TASKS) {
        this.logger.info(`[TASK_${taskId}] Free slot available, executing immediately`);
        this.currentRunningTasks++;

        try {
          await this.executeTaskDirectly(taskId);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.currentRunningTasks--;
          this.logger.info(
            `[TASK_PROCESSOR] Task ${taskId} completed. Running: ${this.currentRunningTasks}, Queue: ${this.taskQueue.length}`,
          );
          this.processQueue();
        }
      } else {
        const queuedTask: QueuedTask = {
          taskId,
          resolve,
          reject,
          priority: Date.now(),
        };

        this.taskQueue.push(queuedTask);
        this.logger.info(
          `[TASK_${taskId}] No free slots, added to queue. Queue length: ${this.taskQueue.length}`,
        );

        this.taskQueue.sort((a, b) => a.priority - b.priority);
        this.processQueue();
      }
    });
  }

  private async processTaskLoop(taskId: string): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const task = await this.taskModel.findById(taskId).exec();
  
      if (!task) {
        this.logger.warn(`[TASK_${taskId}] Task deleted, stopping loop`);
        break;
      }
  
      if (task.status !== TaskStatus.ACTIVE) {
        this.logger.info(`[TASK_${taskId}] status=${task.status}, stopping loop`);
        break;
      }
  
      this.logger.info(`[TASK_${taskId}] 🔁 Starting iteration...`);
  
      try {
        await this.processTask(task);
        await this.taskModel.findByIdAndUpdate(taskId, { lastRunAt: new Date() }).exec();
      } catch (e: any) {
        this.logger.error(`[TASK_${taskId}] Iteration error: ${e.message}`, e);
      }
  
      const fresh = await this.taskModel.findById(taskId).select('status').exec();
      if (!fresh || fresh.status !== TaskStatus.ACTIVE) {
        this.logger.info(`[TASK_${taskId}] Stopped before sleep`);
        break;
      }
  
      this.logger.info(`[TASK_${taskId}] ✅ Iteration finished, waiting 5 seconds...`);
      await this.sleep(5000);
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.currentRunningTasks >= this.MAX_CONCURRENT_TASKS) {
      return;
    }

    this.isProcessing = true;

    while (this.taskQueue.length > 0 && this.currentRunningTasks < this.MAX_CONCURRENT_TASKS) {
      const queuedTask = this.taskQueue.shift();
      if (!queuedTask) break;

      this.currentRunningTasks++;
      this.logger.info(
        `[TASK_PROCESSOR] Starting task ${queuedTask.taskId}. Running: ${this.currentRunningTasks}, Queue: ${this.taskQueue.length}`,
      );

      this.executeTask(queuedTask).finally(() => {
        this.currentRunningTasks--;
        this.logger.info(
          `[TASK_PROCESSOR] Task ${queuedTask.taskId} completed. Running: ${this.currentRunningTasks}, Queue: ${this.taskQueue.length}`,
        );
      });
    }

    this.isProcessing = false;

    if (this.taskQueue.length > 0) {
      setImmediate(() => this.processQueue());
    }
  }

  private async executeTaskDirectly(taskId: string): Promise<void> {
    try {
      const lockedTask = await this.taskModel
        .findOneAndUpdate(
          { _id: taskId, status: TaskStatus.ACTIVE, isRunning: false },
          { $set: { isRunning: true } },
          { new: true },
        )
        .exec();

      if (!lockedTask) {
        const exists = await this.taskModel.findById(taskId).select('status isRunning').exec();
        if (!exists) {
          this.logger.error(`[TASK_${taskId}] Task not found`);
          throw new Error('Task not found');
        }

        if (exists.status !== TaskStatus.ACTIVE) {
          this.logger.warn(
            `[TASK_${taskId}] Task is not active (status: ${exists.status}), skipping`,
          );
          return;
        }

        this.logger.warn(`[TASK_${taskId}] Task is already running, skipping`);
        return;
      }

      this.logger.info(`[TASK_${taskId}] Locked task, starting loop...`);

      try {
        await this.processTaskLoop(taskId);
      } finally {
        try {
          await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
          this.logger.info(`[TASK_${taskId}] Loop stopped, isRunning flag reset`);
        } catch (saveError: any) {
          this.logger.error(
            `[TASK_${taskId}] Failed to reset isRunning flag: ${saveError.message}`,
          );
          try {
            await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
          } catch (retryError: any) {
            this.logger.error(
              `[TASK_${taskId}] Failed to reset isRunning flag on retry: ${retryError.message}`,
            );
          }
        }

        try {
          this.puppeteerService.clearTaskProxyCursor(taskId);
        } catch { /* empty */ }
      }
    } catch (error: any) {
      this.logger.error(`[TASK_${taskId}] Error processing task: ${error.message}`, error);

      try {
        await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
        this.logger.info(`[TASK_${taskId}] Reset isRunning flag after error`);
      } catch (resetError: any) {
        this.logger.error(
          `[TASK_${taskId}] Failed to reset isRunning after error: ${resetError.message}`,
        );
      }

      try {
        this.puppeteerService.clearTaskProxyCursor(taskId);
      } catch { /* empty */ }

      throw error;
    }
  }

  private async executeTask(queuedTask: QueuedTask): Promise<void> {
    const { taskId, resolve, reject } = queuedTask;
  
    try {
      const lockedTask = await this.taskModel
        .findOneAndUpdate(
          { _id: taskId, status: TaskStatus.ACTIVE, isRunning: false },
          { $set: { isRunning: true } },
          { new: true },
        )
        .exec();
  
      if (!lockedTask) {
        const exists = await this.taskModel.findById(taskId).select('status isRunning').exec();
  
        if (!exists) {
          this.logger.error(`[TASK_${taskId}] Task not found`);
          reject(new Error('Task not found'));
          return;
        }
  
        if (exists.status !== TaskStatus.ACTIVE) {
          this.logger.warn(
            `[TASK_${taskId}] Task is not active (status: ${exists.status}), skipping`,
          );
          resolve();
          return;
        }
  
        this.logger.warn(`[TASK_${taskId}] Task is already running, skipping`);
        resolve();
        return;
      }
  
      this.logger.info(`[TASK_${taskId}] Locked task from queue, starting loop...`);
  
      try {
        await this.processTaskLoop(taskId);
        resolve();
      } finally {
        try {
          await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
          this.logger.info(`[TASK_${taskId}] Loop stopped, isRunning flag reset`);
        } catch (saveError: any) {
          this.logger.error(
            `[TASK_${taskId}] Failed to reset isRunning flag: ${saveError.message}`,
          );
          try {
            await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
          } catch (retryError: any) {
            this.logger.error(
              `[TASK_${taskId}] Failed to reset isRunning flag on retry: ${retryError.message}`,
            );
          }
        }
  
        try {
          this.puppeteerService.clearTaskProxyCursor(taskId);
        } catch { /* empty */ }
      }
    } catch (error: any) {
      this.logger.error(`[TASK_${taskId}] Error processing task: ${error.message}`, error);
  
      try {
        await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
        this.logger.info(`[TASK_${taskId}] Reset isRunning flag after error`);
      } catch (resetError: any) {
        this.logger.error(
          `[TASK_${taskId}] Failed to reset isRunning after error: ${resetError.message}`,
        );
      }
  
      try {
        this.puppeteerService.clearTaskProxyCursor(taskId);
      } catch { /* empty */ }
  
      reject(error);
    }
  }

  getQueueStatus(): {
    queueLength: number;
    isProcessing: boolean;
    currentRunningTasks: number;
    maxConcurrentTasks: number;
  } {
    return {
      queueLength: this.taskQueue.length,
      isProcessing: this.isProcessing,
      currentRunningTasks: this.currentRunningTasks,
      maxConcurrentTasks: this.MAX_CONCURRENT_TASKS,
    };
  }

  clearQueue(): number {
    const queueLength = this.taskQueue.length;
    this.taskQueue = [];
    this.logger.info(`[TASK_PROCESSOR] Queue cleared. Removed ${queueLength} tasks`);
    return queueLength;
  }

  private async takeScreenshot(page: Page, taskId: string, stage: string): Promise<void> {
    if (!IS_DEBUG_MODE) {
      return;
    }

    const taskPrefix = `[TASK_${taskId}]`;

    try {
      const screenshotsDir = 'screenshots';
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `task-${taskId}-${stage}-${timestamp}.png`;
      const filepath = path.join(screenshotsDir, filename);

      await page.screenshot({
        path: filepath as `${string}.png`,
        fullPage: true,
      });

      this.logger.info(`${taskPrefix} 📸 Screenshot saved: ${filepath}`);
    } catch (error) {
      this.logger.error(`${taskPrefix} Failed to take screenshot: ${error.message}`);
    }
  }

  private async processTask(task: TaskDocument): Promise<void> {
    const { _id, url, profileId, geo } = task;
    const taskId = _id.toString();
  
    try {
      this.logger.debug(
        `[TASK_${taskId}] Starting task processing: url=${url}, profileId=${profileId}, geo=${geo}`,
      );
  
      let leadData: LeadData;
      let userAgent: string;
      let fbclid: string | null = null;
  
      if (profileId) {
        const profile = await this.geoProfileModel.findById(profileId).exec();
  
        if (!profile) {
          this.logger.error(`[TASK_${taskId}] Profile with ID ${profileId} not found`);
          return;
        }
  
        const { leadKey, fbclidKey, userAgentKey } = profile;
  
        leadData = await this.redisService.getLeadData(leadKey);
        userAgent = await this.redisService.getUserAgentData(userAgentKey);
        fbclid = await this.redisService.getFbclidData(fbclidKey);
      } else {
        this.logger.warn(
          `[TASK_${taskId}] No profileId provided, using generated lead/userAgent/fbclid`,
        );
  
        leadData = generateLeadForGeo(geo);
        userAgent = getRandomDefaultUserAgent();
        fbclid = generateFbclid();
      }
  
      let finalUrl = url;
  
      if (fbclid) {
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl = finalUrl + separator + 'fbclid=' + fbclid;
      }
  
      this.logger.debug(`[TASK_${taskId}] Final URL: ${finalUrl}`);
      this.logger.debug(`[TASK_${taskId}] User agent: ${userAgent}`);
      this.logger.debug(`[TASK_${taskId}] Geo: ${geo}`);
      this.logger.info(`[TASK_${taskId}] Processing lead: ${JSON.stringify(leadData)}`);
  
      const TIMEOUT_MS = 11 * 60 * 1_000;
  
      this.logger.debug(
        `[TASK_${taskId}] Calling runPuppeteerTask with geo=${geo}, userAgent=${userAgent}, url=${finalUrl}`,
      );
  
      await withTimeout(
        this.runPuppeteerTask(task, finalUrl, leadData, userAgent),
        TIMEOUT_MS,
        () => this.logger.error(`[TASK_${taskId}] Task timed out, closing slot`),
      );
  
      await this.taskModel.findByIdAndUpdate(_id, { lastRunAt: new Date() });
      this.logger.info(`[TASK_${taskId}] Task completed. Updated lastRunAt.`);
    } catch (error: any) {
      this.logger.error(
        `[TASK_${taskId}] Error processing task: ${error?.message}, stack: ${error?.stack}`,
      );
      this.logger.error(
        `[TASK_${taskId}] Error context: taskId=${_id}, profileId=${profileId}, geo=${geo}`,
      );
      this.logger.error(`[TASK_${taskId}] Error processing task: ${error?.message}`, error);
    }
  }  

  private async updateTaskStatistics(
    taskId: string,
    finalRedirectUrl: string | null,
  ): Promise<void> {
    try {
      const task = await this.taskModel.findById(taskId).exec();

      if (!task) {
        this.logger.error(`[TASK_${taskId}] Task not found for statistics update`);
        return;
      }

      if (!task.result) {
        this.logger.warn(
          `[TASK_${taskId}] Task result is null, initializing default result structure`,
        );
        task.result = { total: 0, success: {} };
      }

      const currentTotal = task.result?.total || 0;
      task.result.total = currentTotal + 1;

      if (!task.result?.success) {
        task.result.success = {};
      }

      if (finalRedirectUrl) {
        let foundKey: string | undefined;

        for (const key of Object.keys(task.result.success as Record<string, number>)) {
          try {
            if (decodeURIComponent(key) === finalRedirectUrl) {
              foundKey = key;
              break;
            }
          } catch {
            // Ignore
          }
        }

        const redirectKey = foundKey || encodeURIComponent(finalRedirectUrl);
        const currentCount = (task.result.success as Record<string, number>)[redirectKey] || 0;
        (task.result.success as Record<string, number>)[redirectKey] = currentCount + 1;

        task.markModified('result.success');

        if (finalRedirectUrl !== task.url) {
          this.logger.info(`[TASK_${taskId}] ✅ Successful redirect to: ${finalRedirectUrl}`);
        } else {
          this.logger.info(
            `[TASK_${taskId}] ✅ Form submitted successfully (same URL): ${finalRedirectUrl}`,
          );
        }
      } else {
        this.logger.warn(`[TASK_${taskId}] ⚠️ No result URL captured for statistics`);
      }

      await task.save();
    } catch (error) {
      this.logger.error(`[TASK_${taskId}] Error updating task statistics: ${error.message}`, error);
    }
  }

  private async getFinalEffectivePage(
    browser: Browser,
    startPage: Page,
    linkUrl: string,
    maxDepth = 3,
  ): Promise<{ page: Page; effectiveUrl: string; visitedUrls: string[] }> {
    let effectiveUrl = linkUrl;
    let currentPage = startPage;
    const visitedUrls: string[] = [linkUrl];
    let depth = 0;
    let foundFinal = false;
    let u: string | null = null;

    do {
      await currentPage.goto(effectiveUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      const currentUrl = currentPage.url();
      visitedUrls.push(currentUrl);
      try {
        const urlObj = new URL(currentUrl);
        u = urlObj.searchParams.get('u');
        if (u && /^https?:\/\//.test(u)) {
          const decodedU = decodeURIComponent(u);
          if (!decodedU.includes('facebook.com')) {
            effectiveUrl = decodedU;
            foundFinal = true;
            break;
          } else {
            effectiveUrl = decodedU;
            if (currentPage !== startPage) await currentPage.close();
            currentPage = await browser.newPage();
            depth++;
            if (
              urlObj.hostname.endsWith('facebook.com') &&
              (urlObj.pathname.includes('/login.php') ||
                urlObj.pathname.includes('/login/identify'))
            ) {
              this.logger.warn(
                `[fb-final] Попали на страницу логина Facebook: ${currentPage.url()}`,
              );
              break;
            }
          }
        } else {
          u = null;
        }
      } catch {
        u = null;
      }
    } while (u && depth < maxDepth);

    if (!foundFinal) {
      if (u && /^https?:\/\//.test(u) && !decodeURIComponent(u).includes('facebook.com')) {
        effectiveUrl = decodeURIComponent(u);
      } else {
        effectiveUrl = currentPage.url();
      }
    }

    return { page: currentPage, effectiveUrl, visitedUrls };
  }

  private async runPuppeteerTask(
    task: TaskDocument,
    finalUrl: string,
    leadData: LeadData,
    userAgent: string,
  ): Promise<void> {
    const { geo, shouldClickRedirectLink } = task;
    const taskId = task._id.toString();
  
    let finalRedirectUrl: string | null = null;
    let afterSubmitUrl: string | null = null;
  
    let browser: Browser | null = null;
    let page: Page | null = null;
    let finalPage: Page | null = null;
  
    try {
      const isolated = await this.puppeteerService.createIsolatedPage(
        taskId,
        geo as CountryCode,
        userAgent,
        finalUrl,
      );
  
      browser = isolated.browser;
      page = isolated.page;
  
      this.logger.info(`[TASK_${taskId}] Navigating to: ${finalUrl}`);
  
      const { page: resolvedPage } = await this.getFinalEffectivePage(browser, page, finalUrl);
      finalPage = resolvedPage;
  
      if (finalPage.isClosed()) {
        this.logger.warn(`[TASK_${taskId}] Page was closed during navigation`);
        return;
      }
  
      if (shouldClickRedirectLink) {
        this.logger.info(
          `[TASK_${taskId}] shouldClickRedirectLink=true: looking for redirect link after page load`,
        );
        finalPage = await this.tryClickRedirectLink(finalPage, taskId);
      }
  
      await this.sleep(10_000);
  
      await this.safeExecute(finalPage, () => this.simulateScrolling(finalPage, taskId, 'down'));
      await this.safeExecute(finalPage, () => this.simulateRandomClicks(finalPage, taskId));
      await this.safeExecute(finalPage, () => this.simulateScrolling(finalPage, taskId, 'up'));
      await this.safeExecute(finalPage, () => this.findAndOpenForm(finalPage, taskId));
  
      await this.takeScreenshot(finalPage, taskId, 'before-form-fill');
  
      afterSubmitUrl = await this.safeExecute(finalPage, () =>
        this.fillFormWithData(finalPage, leadData, taskId, task.isQuiz, true, geo),
      );
  
      if (finalPage && !finalPage.isClosed()) {
        finalRedirectUrl = finalPage.url();
        this.logger.info(`[TASK_${taskId}] Final redirect URL: ${finalRedirectUrl}`);
      }
    } catch (error: any) {
      this.logger.error(`[TASK_${taskId}] Error in Puppeteer task: ${error.message}`, error);
  
      try {
        if (finalPage && !finalPage.isClosed()) {
          finalRedirectUrl = finalPage.url();
          this.logger.info(`[TASK_${taskId}] Captured URL after error: ${finalRedirectUrl}`);
        } else if (page && !page.isClosed()) {
          finalRedirectUrl = page.url();
          this.logger.info(`[TASK_${taskId}] Captured URL after error (page): ${finalRedirectUrl}`);
        }
      } catch (urlError: any) {
        this.logger.warn(`[TASK_${taskId}] Could not get URL after error: ${urlError.message}`);
      }
    } finally {
      const finalResult = afterSubmitUrl || finalRedirectUrl;
  
      if (finalResult) {
        this.logger.info(`[TASK_${taskId}] Final result URL: ${finalResult}`);
      } else {
        this.logger.info(`[TASK_${taskId}] No result URL captured`);
      }
  
      await this.updateTaskStatistics(taskId, finalResult);
  
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  private async tryClickRedirectLink(page: Page, taskId: string) {
    const taskPrefix = `[TASK_${taskId}]`;
    this.logger.info(`[TASK_${taskId}] scroll & move for 25s…`);
    const start = Date.now();

    while (Date.now() - start < 25_000) {
      await this.safeExecute(page, () => this.simulateScrolling(page, taskId, 'down'));
      await this.sleep(500 + Math.random() * 500);
      await this.safeExecute(page, () => this.simulateRandomClicks(page, taskId));
      await this.sleep(300 + Math.random() * 700);
      await this.safeExecute(page, () => this.simulateScrolling(page, taskId, 'up'));
      await this.sleep(1_000 + Math.random() * 2_000);
    }

    try {
      await page.evaluate(() => {
        document.querySelectorAll('a[target="_blank"]').forEach((a) => a.removeAttribute('target'));
      });

      const debugLinks: { href: string; text: string }[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => ({
          href: a.href,
          text: a.textContent?.trim() || '',
        })),
      );

      const counts: Record<string, number> = {};
      debugLinks.forEach((l) => {
        counts[l.href] = (counts[l.href] || 0) + 1;
      });

      const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
      const targetHref = sorted.length > 0 ? sorted[0][0] : null;

      if (!targetHref) {
        this.logger.warn(`${taskPrefix} [tryClickRedirectLink] No links to redirect to.`);
        return page;
      }

      await page.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch (e) {
      this.logger.warn(`${taskPrefix} Error in tryClickRedirectLink: ${e.message}`);
    }
    return page;
  }

  private async safeExecute<T>(page: Page, action: () => Promise<T>): Promise<T | null> {
    try {
      if (page.isClosed()) {
        this.logger.warn('[TASK_UNKNOWN] Page is closed, skipping action');
        return null;
      }
      return await action();
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed') ||
        error.message.includes('Session closed')
      ) {
        this.logger.warn('[TASK_UNKNOWN] Page context was destroyed, skipping action');
        return null;
      }
      this.logger.error(`[TASK_UNKNOWN] Error executing action: ${error.message}`);
      return null;
    }
  }

  private async simulateScrolling(
    page: Page,
    taskId?: string,
    direction: 'down' | 'up' = 'down',
  ): Promise<void> {
    const taskPrefix = taskId ? `[TASK_${taskId}]` : '[TASK_UNKNOWN]';

    if (page.isClosed()) {
      this.logger.warn(`${taskPrefix} Page is closed, skipping scrolling`);
      return;
    }

    try {
      const pageHeight = await page.evaluate(() => {
        if (!document.body) return 0;
        return document.body.scrollHeight || 0;
      });
      const viewportHeight = await page.evaluate(() => window.innerHeight || 0);
      const currentScrollY = await page.evaluate(() => window.scrollY || 0);

      if (direction === 'down') {
        let currentPosition = currentScrollY;
        const maxScrollSteps = Math.min(5, Math.ceil((pageHeight - viewportHeight) / 300));

        for (let i = 0; i < maxScrollSteps; i++) {
          if (page.isClosed()) break;

          const scrollAmount = Math.floor(Math.random() * 200) + 300;
          currentPosition += scrollAmount;

          if (currentPosition >= pageHeight - viewportHeight) {
            break;
          }

          await page.evaluate((amount) => {
            window.scrollBy({
              top: amount,
              behavior: 'smooth',
            });
          }, scrollAmount);

          const pauseTime = 500 + Math.random() * 800;
          await this.sleep(pauseTime);

          if (Math.random() < 0.15) {
            const backScroll = Math.floor(Math.random() * 100) + 50;
            await page.evaluate((amount) => {
              window.scrollBy({
                top: -amount,
                behavior: 'smooth',
              });
            }, backScroll);
            await this.sleep(300 + Math.random() * 500);
          }
        }
      } else {
        await page.evaluate(() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        });
        await this.sleep(1_000 + Math.random() * 1_000);
      }
    } catch (error) {
      if (error.message.includes('Execution context was destroyed')) {
        this.logger.warn(`${taskPrefix} Page context destroyed during scrolling`);
        return;
      }
      throw error;
    }
  }

  private async simulateRandomClicks(page: Page, taskId: string): Promise<void> {
    const taskPrefix = `[TASK_${taskId}]`;

    if (page.isClosed()) {
      this.logger.warn(`${taskPrefix} Page is closed, skipping random clicks`);
      return;
    }

    try {
      const clickableElements = await page.evaluate(() => {
        const elements = Array.from(
          document.querySelectorAll('a, button, [role="button"], .btn, .button'),
        );
        return elements
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0' &&
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= window.innerHeight &&
              rect.right <= window.innerWidth
            );
          })
          .map((el) => ({
            tagName: el.tagName.toLowerCase(),
            text: el.textContent?.trim().substring(0, 50) || '',
            href: el.getAttribute('href') || '',
            className: el.className || '',
            rect: el.getBoundingClientRect(),
          }));
      });

      if (clickableElements.length > 0) {
        const randomClicks = Math.floor(Math.random() * 2) + 1;
        for (let i = 0; i < randomClicks; i++) {
          const el = clickableElements[Math.floor(Math.random() * clickableElements.length)];

          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) el.click();
            },
            `${el.tagName}${el.href ? `[href="${el.href}"]` : ''}`,
          );
          await this.sleep(800 + Math.random() * 1_200);
        }
      }

      const elementsToClick = clickableElements
        .filter((el) => {
          const href = el.href.toLowerCase();
          return (
            !href.includes('logout') &&
            !href.includes('signout') &&
            !href.includes('exit') &&
            !href.includes('javascript:') &&
            !href.startsWith('#')
          );
        })
        .slice(0, Math.min(3, clickableElements.length));

      for (const element of elementsToClick) {
        if (page.isClosed()) break;

        try {
          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) {
                el.click();
              }
            },
            `${element.tagName}${element.href ? `[href="${element.href}"]` : ''}`,
          );

          await this.sleep(1_000 + Math.random() * 1_500);

          if (element.href && !element.href.startsWith('#')) {
            await page
              .waitForNavigation({ waitUntil: 'networkidle2', timeout: 5_000 })
              .catch(() => {
                this.logger.warn(`${taskPrefix} Page navigation timeout`);
              });

            await this.sleep(1_000 + Math.random() * 2_000);
          }
        } catch (error) {
          this.logger.warn(`${taskPrefix} Failed to click element: ${error.message}`);
        }
      }
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        this.logger.warn(`${taskPrefix} Page context destroyed during random clicks`);
        return;
      }
      throw error;
    }
  }

  private async findAndOpenForm(page: Page, taskId?: string): Promise<void> {
    const taskPrefix = taskId ? `[TASK_${taskId}]` : '[TASK_UNKNOWN]';
    this.logger.info(`${taskPrefix} 🔍 Looking for forms on the page...`);

    if (page.isClosed()) {
      this.logger.warn(`${taskPrefix} Page is closed, skipping form search`);
      return;
    }

    try {
      const formInfo = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        return forms.map((form, index) => ({
          index,
          id: form.id || '',
          className: form.className || '',
          action: form.action || '',
          method: form.method || '',
          visibleInputs: Array.from(form.querySelectorAll('input')).filter((input) => {
            const style = window.getComputedStyle(input);
            return (
              input.type !== 'hidden' && style.display !== 'none' && style.visibility !== 'hidden'
            );
          }).length,
        }));
      });

      if (formInfo.length === 0) {
        this.logger.error(`${taskPrefix} ❌ No forms found on the page`);
        throw new Error(
          `${taskPrefix} No forms found on the page, cannot proceed with form filling`,
        );
      }

      this.logger.info(`${taskPrefix} 📋 Found ${formInfo.length} form(s) on the page`);

      const bestForm = formInfo.find((form) => form.visibleInputs > 0) || formInfo[0];

      if (bestForm) {
        this.logger.info(`${taskPrefix} 🎯 Selected form #${bestForm.index} for interaction`);

        await page.evaluate((formIndex) => {
          const forms = Array.from(document.querySelectorAll('form'));
          const form = forms[formIndex];
          if (form) {
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });

            form.style.border = '3px solid #2196F3';
            form.style.boxShadow = '0 0 20px rgba(33, 150, 243, 0.3)';

            setTimeout(() => {
              form.style.border = '';
              form.style.boxShadow = '';
            }, 3_000);
          }
        }, bestForm.index);

        await this.sleep(2_000);
      }
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        this.logger.warn(`${taskPrefix} Page context destroyed during form search`);
        return;
      }
      this.logger.error(`${taskPrefix} Error finding form: ${error.message}`);
    }
  }

  private getTypingConfig(fieldType: string) {
    const baseConfig = {
      baseDelay: 1_000,
      typingSpeed: 15,
      typoChance: 0.2,
      pauseChance: 0.2,
      pauseDuration: { min: 500, max: 1_000 },
    };

    switch (fieldType) {
      case 'email':
        return {
          ...baseConfig,
          icon: '📧',
          baseDelay: 800,
          typingSpeed: 14,
          pauseChance: 0.55,
          pauseDuration: { min: 800, max: 1_500 },
        };

      case 'phone':
        return {
          ...baseConfig,
          icon: '📞',
          baseDelay: 1200,
          typingSpeed: 23,
          pauseChance: 0.5,
          typoChance: 0,
          pauseDuration: { min: 800, max: 1_500 },
        };

      case 'name':
        return {
          ...baseConfig,
          icon: '👤',
          baseDelay: 1500,
          typingSpeed: 16,
          pauseChance: 0.35,
          pauseDuration: { min: 800, max: 1_500 },
        };

      case 'surname':
        return {
          ...baseConfig,
          icon: '👤',
          baseDelay: 1_500,
          typingSpeed: 18,
          pauseChance: 0.45,
          pauseDuration: { min: 800, max: 1_500 },
        };

      default:
        return {
          ...baseConfig,
          icon: '❓',
          baseDelay: 1_000,
          typingSpeed: 20,
        };
    }
  }

  private async fillFieldWithTyping(
    page: Page,
    selector: string,
    value: string,
    config: {
      icon: string;
      baseDelay: number;
      typingSpeed: number;
      typoChance: number;
      pauseChance: number;
      pauseDuration: { min: number; max: number };
    },
  ): Promise<void> {
    await this.prepareField(page, selector);

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      await this.addCharacter(page, selector, char);

      const totalDelay = config.baseDelay + Math.random() * config.typingSpeed;
      await this.sleep(totalDelay);

      if (Math.random() < config.typoChance && i < value.length - 1) {
        await this.simulateTypo(page, selector);
      }

      if (Math.random() < config.pauseChance && i < value.length - 1) {
        const pauseDelay =
          config.pauseDuration.min +
          Math.random() * (config.pauseDuration.max - config.pauseDuration.min);
        await this.sleep(pauseDelay);
      }
    }
  }

  private async prepareField(page: Page, selector: string): Promise<void> {
    await page.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      if (element) {
        element.focus();
        element.click();
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);

    await this.sleep(200 + Math.random() * 300);
  }

  private async addCharacter(page: Page, selector: string, char: string): Promise<void> {
    await page.evaluate(
      (selector, char) => {
        const element = document.querySelector(selector) as HTMLInputElement;
        if (element) {
          element.value += char;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      },
      selector,
      char,
    );
  }

  private async simulateTypo(page: Page, selector: string): Promise<void> {
    const typoChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));

    await this.addCharacter(page, selector, typoChar);

    await this.sleep(200 + Math.random() * 300);

    await page.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      if (element) {
        element.value = element.value.slice(0, -1);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);

    await this.sleep(150 + Math.random() * 200);
  }

  private async simulateMouseMovement(
    page: Page,
    selector: string,
    taskId?: string,
  ): Promise<void> {
    const taskPrefix = taskId ? `[TASK_${taskId}]` : '[TASK_UNKNOWN]';

    if (!page.mouse) return;

    try {
      const rect = await page.evaluate((selector) => {
        const el = document.querySelector(selector) as HTMLElement;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, selector);

      if (rect) {
        const steps = 10 + Math.floor(Math.random() * 10);
        await page.mouse.move(rect.x, rect.y, { steps });

        await this.sleep(100 + Math.random() * 300);
      }
    } catch (error) {
      this.logger.debug(`${taskPrefix} Failed to move mouse to field: ${error.message}`);
    }
  }

  private async simulateFieldTransition(page: Page): Promise<void> {
    const basePause = 800 + Math.random() * 1200;
    const readingPause = Math.random() < 0.2 ? 500 + Math.random() * 1_000 : 0;
    const quickPause = Math.random() < 0.1 ? Math.random() * 300 : 0;
    const totalPause = basePause + readingPause + quickPause;

    if (Math.random() < 0.1) {
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div, p, span, section, article'));
        const candidates = all.filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            (el as HTMLElement).offsetParent !== null &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            el.clientHeight > 10 &&
            el.clientWidth > 10
          );
        });
        if (candidates.length > 0) {
          const el = candidates[Math.floor(Math.random() * candidates.length)] as HTMLElement;
          el.click();
        }
      });

      if (page.mouse && page.evaluate) {
        const pos = await page.evaluate(
          () => (window as any).__lastRandomClick || { x: 100, y: 100 },
        );
        await page.mouse.move(pos.x, pos.y, { steps: 10 });
      }

      await this.sleep(400 + Math.random() * 600);
    }

    await this.sleep(totalPause);
  }

  private async fillFormWithData(
    page: Page,
    leadData: LeadData,
    taskId?: string,
    isQuiz?: boolean,
    humanize = true,
    geo?: string,
  ): Promise<string | null> {
    const taskPrefix = taskId ? `[TASK_${taskId}]` : '[TASK_UNKNOWN]';
  
    this.logger.info(`${taskPrefix} Available lead data: ${JSON.stringify(leadData)}`);
  
    if (page.isClosed()) {
      this.logger.warn(`${taskPrefix} Page is closed, skipping form filling`);
      return null;
    }
  
    const sleep = (ms: number) => this.sleep(ms);
  
    try {
      if (humanize) {
        const prePause = 1000 + Math.random() * 3000;
        this.logger.info(`${taskPrefix} (Humanize) Pause before filling form: ${prePause.toFixed(0)}ms`);
        await sleep(prePause);
  
        const randomClicks = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < randomClicks; i++) {
          await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('div, p, span, section, article'));
            const candidates = all.filter((el) => {
              const style = window.getComputedStyle(el);
              return (
                (el as HTMLElement).offsetParent !== null &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                el.clientHeight > 10 &&
                el.clientWidth > 10
              );
            });
  
            if (candidates.length > 0) {
              const el = candidates[Math.floor(Math.random() * candidates.length)] as HTMLElement;
              const rect = el.getBoundingClientRect();
              (window as any).__lastRandomClick = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              el.click();
            }
          });
  
          if (page.mouse && page.evaluate) {
            const pos = await page.evaluate(() => (window as any).__lastRandomClick || { x: 100, y: 100 });
            await page.mouse.move(pos.x, pos.y, { steps: 10 });
          }
  
          await sleep(400 + Math.random() * 600);
        }
      } else {
        await sleep(100);
      }
  
      await page.evaluate((fast) => {
        const forms = document.querySelectorAll('form');
        if (forms.length > 0) {
          (forms[0] as HTMLElement).scrollIntoView({ behavior: fast ? 'auto' : 'smooth', block: 'center' });
        }
      }, !humanize);
  
      if (humanize) await sleep(1000 + Math.random() * 1000);
      else await sleep(150);
  
      const beforeSubmitUrl = page.url();
  
      if (isQuiz) {
        this.logger.info(`${taskPrefix} This is a quiz task, using JavaScript code generation approach`);
        try {
          const formsHtml = await this.aiService.extractFormHtml(page);
          if (!formsHtml.trim()) {
            this.logger.warn(`${taskPrefix} No forms found on the page`);
            throw new Error(`${taskPrefix} No forms found on the page, cannot proceed with form filling`);
          }
  
          const jsCode = await this.aiService.generateFormFillScript(formsHtml, leadData);
          this.logger.info(`${taskPrefix} Generated JavaScript code for quiz form filling`);
  
          await page.evaluate(jsCode);
          this.logger.info(`${taskPrefix} Executed JavaScript code for quiz form filling`);
        } catch (quizError: any) {
          this.logger.error(
            `${taskPrefix} Quiz form filling failed: ${quizError?.message ?? quizError}, falling back to regular method`,
          );
          isQuiz = false;
        }
      }
  
      let analysis: any;
  
      if (!isQuiz) {
        try {
          const formsHtml = await this.aiService.extractFormHtml(page);
          if (!formsHtml.trim()) {
            this.logger.warn(`${taskPrefix} No forms found on the page`);
            return null;
          }
          analysis = await this.aiService.analyzeForms(formsHtml);
        } catch (aiError: any) {
          this.logger.warn(`${taskPrefix} AI analysis failed: ${aiError.message}, trying fallback method`);
          try {
            analysis = await this.aiService.analyzeFormsFallback(page);
          } catch (fallbackError: any) {
            this.logger.error(`${taskPrefix} Both AI and fallback analysis failed: ${fallbackError.message}`);
            return null;
          }
        }
  
        if (!analysis?.bestForm || !analysis.bestForm.fields || analysis.bestForm.fields.length === 0) {
          this.logger.warn(`${taskPrefix} Could not identify suitable form fields`);
          return null;
        }
  
        this.logger.info(
          `${taskPrefix} Selected form #${analysis.bestForm.formIndex} with ${analysis.bestForm.fields.length} fields`,
        );
  
        await page.evaluate((formIndex: number, fast: boolean) => {
          const forms = Array.from(document.querySelectorAll('form'));
          const form = forms[formIndex];
          if (form) (form as HTMLElement).scrollIntoView({ behavior: fast ? 'auto' : 'smooth', block: 'center' });
        }, analysis.bestForm.formIndex, !humanize);
  
        if (humanize) await sleep(1500 + Math.random() * 1000);
        else await sleep(200);
  
        for (const field of analysis.bestForm.fields) {
          if (page.isClosed()) {
            this.logger.warn(`${taskPrefix} Page is closed, stopping form filling`);
            return null;
          }
  
          let value = '';
          switch (field.type) {
            case 'name':
              value = leadData.name || '';
              break;
            case 'surname':
              value = leadData.lastname || '';
              break;
            case 'phone':
              value = leadData.phone || '';
              break;
            case 'email':
              value = leadData.email || '';
              break;
            default:
              value = '';
          }
  
          if (!value) {
            this.logger.warn(`${taskPrefix} No value for field type: ${field.type}, skipping`);
            continue;
          }
  
          try {
            const fieldExists = await page.evaluate((selector: string, fast: boolean) => {
              const element = document.querySelector(selector) as HTMLInputElement | null;
              if (element) {
                (element as HTMLElement).scrollIntoView({ behavior: fast ? 'auto' : 'smooth', block: 'center' });
                return true;
              }
              return false;
            }, field.selector, !humanize);
  
            if (!fieldExists) {
              this.logger.warn(`${taskPrefix} Field not found: ${field.selector}, skipping`);
              continue;
            }
  
            if (humanize) await sleep(500 + Math.random() * 500);
            else await sleep(80);

            if (field.type === 'phone' && geo) {
              try {
                const appliedIntl = await this.trySelectPhoneCountryIntlTelInput(
                  page,
                  analysis.bestForm.formIndex,
                  field.selector,
                  geo,
                  taskPrefix,
                );
  
                this.logger.info(
                  `${taskPrefix} Phone country selector (intl-tel-input): ${appliedIntl ? 'selected' : 'not found/failed'}`,
                );
  
                await sleep(humanize ? 250 : 80);
              } catch (e: any) {
                this.logger.warn(`${taskPrefix} intl-tel-input selection failed: ${e?.message ?? e}`);
              }
            }
  
            if (humanize && page.mouse) {
              const rect = await page.evaluate((selector: string) => {
                const el = document.querySelector(selector) as HTMLElement | null;
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
              }, field.selector);
  
              if (rect) {
                await page.mouse.move(rect.x, rect.y, { steps: 15 });
                await sleep(200 + Math.random() * 300);
              }
            }
  
            if (humanize && Math.random() < 0.2) {
              this.logger.info(`${taskPrefix} (Humanize) Not focusing immediately on field: ${field.selector}`);
              await sleep(600 + Math.random() * 800);
            }
  
            await page.evaluate((selector: string) => {
              const element = document.querySelector(selector) as HTMLInputElement | null;
              if (element) {
                element.focus();
                element.click();
              }
            }, field.selector);
  
            await sleep(humanize ? (200 + Math.random() * 300) : (100 + Math.random() * 100));
  
            if (humanize) {
              this.logger.info(`${taskPrefix} 🎯 Starting humanized typing for field: ${field.selector}`);
  
              await page.evaluate((selector: string) => {
                const el = document.querySelector(selector) as HTMLInputElement | null;
                if (!el) return;
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, field.selector);
  
              for (let i = 0; i < value.length; i++) {
                await page.evaluate(
                  (selector: string, char: string) => {
                    const element = document.querySelector(selector) as HTMLInputElement | null;
                    if (element) {
                      element.value += char;
                      element.dispatchEvent(new Event('input', { bubbles: true }));
                      element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  },
                  field.selector,
                  value[i],
                );
  
                const totalDelay = 300 + Math.random() * 900;
                await sleep(totalDelay);
  
                if (Math.random() < 0.05 && i < value.length - 1) {
                  const typoChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
                  this.logger.debug(`${taskPrefix} ⌨️ Made typo: "${typoChar}", correcting...`);
  
                  await page.evaluate(
                    (selector: string, typoChar: string) => {
                      const element = document.querySelector(selector) as HTMLInputElement | null;
                      if (element) {
                        element.value += typoChar;
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                      }
                    },
                    field.selector,
                    typoChar,
                  );
  
                  await sleep(200 + Math.random() * 300);
  
                  await page.evaluate((selector: string) => {
                    const element = document.querySelector(selector) as HTMLInputElement | null;
                    if (element) {
                      element.value = element.value.slice(0, -1);
                      element.dispatchEvent(new Event('input', { bubbles: true }));
                      element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }, field.selector);
  
                  await sleep(150 + Math.random() * 200);
                }
              }
            } else {
              await page.evaluate((selector: string) => {
                const el = document.querySelector(selector) as HTMLInputElement | null;
                if (!el) return;
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, field.selector);
  
              const chunkSize = Math.max(1, Math.floor(value.length / 3));
              for (let i = 0; i < value.length; i += chunkSize) {
                const chunk = value.slice(i, i + chunkSize);
  
                await page.evaluate(
                  (selector: string, chunk: string) => {
                    const element = document.querySelector(selector) as HTMLInputElement | null;
                    if (element) {
                      element.value += chunk;
                      element.dispatchEvent(new Event('input', { bubbles: true }));
                      element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  },
                  field.selector,
                  chunk,
                );
  
                await sleep(200 + Math.random() * 300);
              }
            }
  
            this.logger.info(
              `${taskPrefix} ✅ Filled field ${field.selector} (${field.type}) with value: ${value} (confidence: ${field.confidence})`,
            );
  
            if (humanize && Math.random() < 0.1) {
              this.logger.info(`${taskPrefix} (Humanize) Clicking outside form after field`);
              await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('div, p, span, section, article'));
                const candidates = all.filter((el) => {
                  const style = window.getComputedStyle(el);
                  return (
                    (el as HTMLElement).offsetParent !== null &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0' &&
                    el.clientHeight > 10 &&
                    el.clientWidth > 10
                  );
                });
                if (candidates.length > 0) {
                  const el = candidates[Math.floor(Math.random() * candidates.length)] as HTMLElement;
                  const rect = el.getBoundingClientRect();
                  (window as any).__lastRandomClick = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                  el.click();
                }
              });
  
              if (page.mouse && page.evaluate) {
                const pos = await page.evaluate(() => (window as any).__lastRandomClick || { x: 100, y: 100 });
                await page.mouse.move(pos.x, pos.y, { steps: 10 });
              }
  
              await sleep(400 + Math.random() * 600);
            }
  
            if (humanize) {
              const basePause = 800 + Math.random() * 1200;
              const readingPause = Math.random() < 0.2 ? 500 + Math.random() * 1000 : 0;
              const quickPause = Math.random() < 0.1 ? Math.random() * 300 : 0;
              await sleep(basePause + readingPause + quickPause);
            } else {
              await sleep(120);
            }
          } catch (error: any) {
            this.logger.warn(`${taskPrefix} Failed to fill field ${field.selector}: ${error.message}`);
          }
        }
  
        this.logger.info(`${taskPrefix} All fields filled; URL before form submission: ${beforeSubmitUrl}`);
        if (humanize) await sleep(1000 + Math.random() * 1000);
        else await sleep(200);
  
        if (analysis.bestForm.checkboxes?.length) {
          for (const cb of analysis.bestForm.checkboxes) {
            try {
              const isChecked = await page.evaluate((sel: string) => {
                const el = document.querySelector(sel) as HTMLInputElement | null;
                return el?.checked === true;
              }, cb.selector);
  
              if (!isChecked) {
                if (humanize && page.mouse) {
                  const rect = await page.evaluate((selector: string) => {
                    const el = document.querySelector(selector) as HTMLElement | null;
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                  }, cb.selector);
                  if (rect) await page.mouse.move(rect.x, rect.y, { steps: 10 });
                }
  
                await sleep(humanize ? (300 + Math.random() * 700) : 120);
  
                await page.evaluate((sel: string) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  el?.click();
                }, cb.selector);
  
                this.logger.info(
                  `${taskPrefix} ✅ Checked checkbox ${cb.selector}` +
                    (cb.label ? ` (${cb.label})` : '') +
                    ` — confidence: ${cb.confidence}`,
                );
  
                await sleep(humanize ? (400 + Math.random() * 600) : 120);
              }
            } catch (err: any) {
              this.logger.warn(`${taskPrefix} Failed to check checkbox ${cb.selector}: ${err.message}`);
            }
          }
        }
  
        await this.takeScreenshot(page, taskId, 'after-form-fill');
  
        const submitResult = await page.evaluate((formIndex: number, fast: boolean) => {
          const forms = Array.from(document.querySelectorAll('form'));
          const form = forms[formIndex];
          if (!form) return 'form_not_found';
  
          let submitButton =
            form.querySelector('button[type="submit"], input[type="submit"]') as HTMLButtonElement | HTMLInputElement | null;
  
          if (!submitButton) {
            const buttons = Array.from(form.querySelectorAll('button'));
            submitButton = buttons.find((btn) => {
              const text = btn.textContent?.toLowerCase() || '';
              return (
                text.includes('submit') ||
                text.includes('send') ||
                text.includes('отправить') ||
                text.includes('подтвердить')
              );
            }) as HTMLButtonElement | null;
          }
  
          if (submitButton && (submitButton as HTMLElement).offsetParent !== null) {
            (submitButton as HTMLElement).scrollIntoView({ behavior: fast ? 'auto' : 'smooth', block: 'center' });
  
            if (fast) {
              (submitButton as HTMLElement).click();
            } else {
              setTimeout(() => (submitButton as HTMLElement).click(), 1000 + Math.random() * 1000);
            }
  
            return 'clicked_submit_button';
          } else {
            if (fast) {
              (form as HTMLFormElement).submit();
            } else {
              setTimeout(() => (form as HTMLFormElement).submit(), 1000 + Math.random() * 1000);
            }
            return 'called_form_submit';
          }
        }, analysis.bestForm.formIndex, !humanize);
  
        this.logger.info(`${taskPrefix} 🎉 Form submit result: ${submitResult}`);
      }
  
      const waitAfterSubmit = humanize ? 20_000 : 10_000;
      this.logger.info(`${taskPrefix} Waiting ${waitAfterSubmit}ms after form submission...`);
      await sleep(waitAfterSubmit);
  
      await this.takeScreenshot(page, taskId, 'thank-you');
  
      let afterSubmitUrl: string | null = null;
  
      try {
        await page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: humanize ? 10_000 : 6_000,
        });
        afterSubmitUrl = page.url();
        this.logger.info(`${taskPrefix} ✅ Navigation completed after form submission: ${afterSubmitUrl}`);
      } catch {
        this.logger.info(`${taskPrefix} ℹ️ Navigation timeout after form submission (can be normal)`);
  
        const currentUrl = page.url();
        if (currentUrl !== beforeSubmitUrl) {
          afterSubmitUrl = currentUrl;
          this.logger.info(`${taskPrefix} ✅ URL changed despite navigation timeout: ${afterSubmitUrl}`);
  
          const redirectAnalysis = this.analyzeRedirect(currentUrl, beforeSubmitUrl);
          this.logger.info(`${taskPrefix} 📊 Redirect analysis: ${redirectAnalysis.reason}`);
        } else {
          const submissionResult = await this.detectFormSubmissionSuccess(page, taskId, beforeSubmitUrl);
  
          if (submissionResult.isSuccess) {
            this.logger.info(`${taskPrefix} ✅ Form submission appears successful: ${submissionResult.reason}`);
            afterSubmitUrl = submissionResult.url;
          } else {
            this.logger.info(`${taskPrefix} ℹ️ ${submissionResult.reason} - treating as potential success`);
            afterSubmitUrl = currentUrl;
          }
        }
      }
  
      return afterSubmitUrl;
    } catch (error: any) {
      if (
        error?.message?.includes('Execution context was destroyed') ||
        error?.message?.includes('Target closed')
      ) {
        this.logger.warn(`${taskPrefix} Page context destroyed during form filling`);
        return null;
      }
      this.logger.error(`${taskPrefix} Error filling form with AI: ${error.message}`, error);
      return null;
    }
  }  

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async detectFormSubmissionSuccess(
    page: Page,
    taskId: string,
    originalUrl?: string,
  ): Promise<{
    isSuccess: boolean;
    reason: string;
    url: string;
  }> {
    const taskPrefix = `[TASK_${taskId}]`;

    try {
      if (page.isClosed()) {
        return { isSuccess: false, reason: 'Page is closed', url: '' };
      }

      const result = await page.evaluate(() => {
        const successIndicators = [
          'thank you',
          'thankyou',
          'success',
          'успешно',
          'спасибо',
          'отправлено',
          'подтверждено',
          'заявка принята',
          'application received',
          'form submitted',
          'form sent',
          'ваша заявка',
          'ваше сообщение',
          'your application',
          'your message',
          'received',
          'accepted',
          'принята',
          'получена',
        ];

        const errorIndicators = [
          'error',
          'ошибка',
          'failed',
          'неудачно',
          'попробуйте еще раз',
          'try again',
          'invalid',
          'неверно',
          'required',
          'обязательно',
        ];

        const pageText = document.body?.textContent?.toLowerCase() || '';
        const pageTitle = document.title?.toLowerCase() || '';
        const url = window.location.href;

        const hasSuccessText = successIndicators.some(
          (indicator) => pageText.includes(indicator) || pageTitle.includes(indicator),
        );

        const hasErrorText = errorIndicators.some(
          (indicator) => pageText.includes(indicator) || pageTitle.includes(indicator),
        );

        const hasForm = document.querySelector('form') !== null;
        const hasSubmitButton =
          document.querySelector('button[type="submit"], input[type="submit"]') !== null;
        const hasErrorMessage =
          document.querySelector('.error, .alert-danger, .error-message') !== null;
        const hasSuccessMessage =
          document.querySelector('.success, .alert-success, .success-message') !== null;

        return {
          hasSuccessText,
          hasErrorText,
          hasForm,
          hasSubmitButton,
          hasErrorMessage,
          hasSuccessMessage,
          pageTitle: document.title,
          url,
        };
      });

      const currentUrl = result.url;
      const hasRedirect = originalUrl && currentUrl !== originalUrl;

      if (hasRedirect) {
        const redirectAnalysis = this.analyzeRedirect(currentUrl, originalUrl);
        if (redirectAnalysis.isSuccess) {
          return {
            isSuccess: true,
            reason: `Redirect detected: ${redirectAnalysis.reason}`,
            url: currentUrl,
          };
        }
      }

      if (result.hasErrorText || result.hasErrorMessage) {
        return {
          isSuccess: false,
          reason: `Error indicators found: "${result.pageTitle}"`,
          url: result.url,
        };
      }

      if (result.hasSuccessText || result.hasSuccessMessage) {
        return {
          isSuccess: true,
          reason: `Success indicators found: "${result.pageTitle}"`,
          url: result.url,
        };
      }

      // If there's no form or submit button, it might indicate successful submission
      if (!result.hasForm && !result.hasSubmitButton) {
        return {
          isSuccess: true,
          reason: 'No form found on page, likely successful submission',
          url: result.url,
        };
      }

      // If form is still present but no error indicators, consider it potentially successful
      return {
        isSuccess: true,
        reason: 'Form present but no error indicators',
        url: result.url,
      };
    } catch (error) {
      this.logger.warn(`${taskPrefix} Error detecting form submission success: ${error.message}`);
      return { isSuccess: false, reason: `Detection error: ${error.message}`, url: '' };
    }
  }

  private analyzeRedirect(
    currentUrl: string,
    originalUrl: string,
  ): {
    isSuccess: boolean;
    reason: string;
  } {
    try {
      const currentUrlObj = new URL(currentUrl);
      const originalUrlObj = new URL(originalUrl);

      const thankYouPatterns = [
        'thank',
        'thanks',
        'спасибо',
        'благодарим',
        'thankyou',
        'success',
        'успешно',
        'confirmation',
        'подтверждение',
      ];

      const currentPath = currentUrlObj.pathname.toLowerCase();
      const currentHost = currentUrlObj.hostname.toLowerCase();
      const originalHost = originalUrlObj.hostname.toLowerCase();

      const hasThankYouPattern = thankYouPatterns.some(
        (pattern) => currentPath.includes(pattern) || currentUrl.toLowerCase().includes(pattern),
      );

      if (hasThankYouPattern) {
        return {
          isSuccess: true,
          reason: `Redirect to thank you page: ${currentPath}`,
        };
      }

      if (currentHost === originalHost && currentPath !== originalUrlObj.pathname) {
        return {
          isSuccess: true,
          reason: `Redirect to different page on same domain: ${currentPath}`,
        };
      }

      if (currentHost !== originalHost) {
        const analyticsPatterns = [
          'google.com/analytics',
          'facebook.com',
          'yandex.ru',
          'mail.ru',
          'vk.com',
          'ok.ru',
          'doubleclick.net',
          'googlesyndication.com',
        ];

        const isAnalyticsRedirect = analyticsPatterns.some(
          (pattern) => currentHost.includes(pattern) || currentUrl.includes(pattern),
        );

        if (isAnalyticsRedirect) {
          return {
            isSuccess: true,
            reason: `Redirect to analytics/partner system: ${currentHost}`,
          };
        }

        return {
          isSuccess: true,
          reason: `Redirect to external site: ${currentHost}`,
        };
      }

      const successParams = [
        'success=true',
        'status=success',
        'result=ok',
        'success=1',
        'status=ok',
        'result=success',
      ];

      const hasSuccessParam = successParams.some((param) =>
        currentUrl.toLowerCase().includes(param),
      );

      if (hasSuccessParam) {
        return {
          isSuccess: true,
          reason: `Redirect with success parameter: ${currentUrl}`,
        };
      }

      return {
        isSuccess: true,
        reason: `URL changed from ${originalUrlObj.pathname} to ${currentPath}`,
      };
    } catch {
      return {
        isSuccess: true,
        reason: `URL changed (parsing error): ${currentUrl}`,
      };
    }
  }

  private async trySelectPhoneCountryIntlTelInput(
    page: Page,
    formIndex: number,
    phoneSelector: string,
    geo: string,
    taskPrefix: string,
  ): Promise<boolean> {
    const iso2 = (geo || '').trim().toLowerCase();
    if (!iso2) return false;

    try {
      const res = await page.evaluate(async ({ formIndex, phoneSelector, iso2 }) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms[formIndex];
        if (!form) return { ok: false, reason: 'form_not_found' };

        const input = form.querySelector(phoneSelector) as HTMLInputElement | null;
        if (!input) return { ok: false, reason: 'phone_input_not_found' };

        const itiRoot = input.closest('.iti') as HTMLElement | null;
        if (!itiRoot) return { ok: false, reason: 'iti_root_not_found' };

        const btn = itiRoot.querySelector<HTMLElement>('button.iti__selected-country[role="combobox"]');
        if (!btn) return { ok: false, reason: 'selected_country_button_not_found' };

        const dropdownId = btn.getAttribute('aria-controls');
        btn.click();
        await sleep(150);

        const dropdown =
          (dropdownId ? document.getElementById(dropdownId) : null) ||
          document.querySelector<HTMLElement>('.iti__dropdown-content, .iti__country-list');

        if (!dropdown) return { ok: false, reason: 'dropdown_not_found' };

        const option =
          dropdown.querySelector<HTMLElement>(`.iti__country[data-country-code="${iso2}"]`) ||
          document.querySelector<HTMLElement>(`.iti__country[data-country-code="${iso2}"]`);

        if (!option) return { ok: false, reason: 'country_option_not_found' };

        option.click();
        await sleep(100);

        const dial = itiRoot.querySelector<HTMLElement>('.iti__selected-dial-code')?.textContent?.trim() || '';
        return { ok: dial.length > 0, reason: dial.length > 0 ? 'selected' : 'dial_code_empty' };
      }, { formIndex, phoneSelector, iso2 });

      if (!res?.ok) {
        this.logger.warn(`${taskPrefix} intl-tel-input select failed: ${res?.reason}`);
        return false;
      }

      this.logger.info(`${taskPrefix} intl-tel-input country selected for geo=${geo}`);
      return true;
    } catch (e) {
      this.logger.warn(`${taskPrefix} intl-tel-input select error: ${e.message}`);
      return false;
    }
  }
}
