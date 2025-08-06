import { CountryCode, TaskStatus } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { IS_DEBUG_MODE, LogWrapper } from '@utils';
import * as fs from 'fs';
import { Model } from 'mongoose';
import * as path from 'path';
import { Browser, Page } from 'puppeteer';

import { AIService } from '../ai/ai.service';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { RedisService } from '../redis/redis.service';
import { checkSuccessIndicators } from '../utils/success-indicators';

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

@Injectable()
export class TaskProcessorService {
  private readonly logger = new LogWrapper(TaskProcessorService.name);
  private taskQueue: Array<{ taskId: string; priority: number }> = [];
  private isProcessingQueue = false;
  private readonly QUEUE_DELAY_MS = 2000;
  private readonly MAX_CONCURRENT_TASKS = 3;
  private activeTaskCount = 0;

  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    @InjectModel(GeoProfile.name) private geoProfileModel: Model<GeoProfile>,
    private readonly puppeteerService: PuppeteerService,
    private readonly redisService: RedisService,
    private readonly aiService: AIService,
  ) {}

  async processAllActiveTasks(): Promise<void> {
    try {
      const activeTasks = await this.taskModel.find({ status: TaskStatus.ACTIVE }).exec();

      this.logger.info(`[TASK_PROCESSOR] Found ${activeTasks.length} active tasks to process`);

      if (activeTasks.length === 0) {
        this.logger.info(`[TASK_PROCESSOR] No active tasks found`);
        return;
      }

      for (const task of activeTasks) {
        this.addTaskToQueue(task._id.toString(), 1);
      }

      this.logger.info(`[TASK_PROCESSOR] 📋 Added ${activeTasks.length} tasks to queue`);

      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    } catch (error) {
      this.logger.error(`[TASK_PROCESSOR] Error processing active tasks: ${error.message}`, error);
    }
  }

  private addTaskToQueue(taskId: string, priority: number): void {
    this.taskQueue.push({ taskId, priority });
    this.logger.debug(`[TASK_PROCESSOR] 📋 Added task ${taskId} to queue (priority: ${priority})`);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      this.logger.debug(`[TASK_PROCESSOR] Queue is already being processed`);
      return;
    }

    this.isProcessingQueue = true;
    this.logger.info(`[TASK_PROCESSOR] 🚀 Starting queue processing...`);

    try {
      while (this.taskQueue.length > 0 || this.activeTaskCount > 0) {
        if (this.activeTaskCount < this.MAX_CONCURRENT_TASKS && this.taskQueue.length > 0) {
          const taskItem = this.taskQueue.shift();
          if (taskItem) {
            this.activeTaskCount++;
            this.logger.info(
              `[TASK_PROCESSOR] 🚀 Starting task ${taskItem.taskId} (active: ${this.activeTaskCount}/${this.MAX_CONCURRENT_TASKS})`,
            );

            this.processTasks(taskItem.taskId)
              .catch((e) => {
                this.logger.error(`[TASK_${taskItem.taskId}] Error processing task: ${e.message}`);
              })
              .finally(() => {
                this.activeTaskCount--;
                this.logger.debug(
                  `[TASK_PROCESSOR] ✅ Task ${taskItem.taskId} completed (active: ${this.activeTaskCount}/${this.MAX_CONCURRENT_TASKS})`,
                );
              });
          }
        }

        await this.sleep(500);
      }

      this.logger.info(`[TASK_PROCESSOR] ✅ Queue processing completed`);
    } catch (error) {
      this.logger.error(`[TASK_PROCESSOR] Error in queue processing: ${error.message}`, error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async processTasks(taskId: string): Promise<void> {
    try {
      this.logger.info(`[TASK_${taskId}] 🚀 Starting task processing...`);

      const delay = Math.floor(Math.random() * 2000) + 1000;
      this.logger.debug(`[TASK_${taskId}] ⏳ Waiting ${delay}ms before starting...`);
      await this.sleep(delay);

      const task = await this.taskModel.findById(taskId).exec();

      if (!task) {
        this.logger.error(`[TASK_${taskId}] Task not found`);
        return;
      }

      if (task.isRunning) {
        this.logger.warn(`[TASK_${taskId}] Task is already running, skipping`);
        return;
      }

      this.logger.info(`[TASK_${taskId}] ✅ Task acquired, starting execution...`);

      task.isRunning = true;
      await task.save();

      try {
        await this.processTask(task);
      } finally {
        try {
          task.isRunning = false;
          await task.save();
        } catch (saveError) {
          this.logger.error(
            `[TASK_${taskId}] Failed to reset isRunning flag: ${saveError.message}`,
          );
          await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
        }
      }
    } catch (error) {
      this.logger.error(`[TASK_${taskId}] Error processing task: ${error.message}`, error);
      try {
        await this.taskModel.findByIdAndUpdate(taskId, { isRunning: false }).exec();
      } catch (resetError) {
        this.logger.error(
          `[TASK_${taskId}] Failed to reset isRunning after error: ${resetError.message}`,
        );
      }
    }
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
      const profile = await this.geoProfileModel.findById(profileId).exec();

      if (!profile) {
        this.logger.error(`[TASK_${taskId}] Profile with ID ${profileId} not found`);
        return;
      }

      const { leadKey, fbclidKey, userAgentKey } = profile;
      const leadData = await this.redisService.getLeadData(leadKey);
      const userAgent = await this.redisService.getUserAgentData(userAgentKey);
      const fbclid = await this.redisService.getFbclidData(fbclidKey);

      let finalUrl = url;

      if (fbclid) {
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl = finalUrl + separator + 'fbclid=' + fbclid;
      }

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
    } catch (error) {
      this.logger.error(
        `[TASK_${taskId}] Error processing task: ${error.message}, stack: ${error.stack}`,
      );
      this.logger.error(
        `[TASK_${taskId}] Error context: taskId=${_id}, profileId=${profileId}, geo=${geo}`,
      );
      this.logger.error(`[TASK_${taskId}] Error processing task: ${error.message}`, error);
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

      if (finalRedirectUrl && finalRedirectUrl !== task.url) {
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

        this.logger.info(`[TASK_${taskId}] Successful redirect to: ${finalRedirectUrl}`);
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
    const taskStartTime = Date.now();

    let page: Page | null = null;
    let finalPage: Page | null = null;
    let afterSubmitUrl;

    try {
      this.logger.info(`[TASK_${taskId}] 🚀 Starting task, acquiring page for geo=${geo}`);
      const puppeteerPage = await this.puppeteerService.acquirePage(geo as CountryCode, userAgent);
      page = puppeteerPage;
      this.logger.info(`[TASK_${taskId}] ✅ Page acquired successfully`);

      this.logger.info(`[TASK_${taskId}] Navigating to: ${finalUrl}`);

      const { page: resolvedPage } = await this.getFinalEffectivePage(
        page.browser(),
        page,
        finalUrl,
      );
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
        this.fillFormWithData(finalPage, leadData, taskId, task.isQuiz, geo as CountryCode),
      );

      if (!finalPage.isClosed()) {
        finalRedirectUrl = finalPage.url();
        this.logger.info(`[TASK_${taskId}] Final redirect URL: ${finalRedirectUrl}`);
      }
    } catch (error) {
      if (
        error.message.includes('net::ERR_TUNNEL_CONNECTION_FAILED') ||
        error.message.includes('net::ERR_') ||
        error.message.includes('ERR_TUNNEL_CONNECTION_FAILED')
      ) {
        this.logger.warn(`[TASK_${taskId}] Network error: ${error.message}`);
      } else if (
        error.message.includes('SyntaxError') ||
        error.message.includes('Unexpected token') ||
        error.message.includes('Unexpected identifier') ||
        error.message.includes('Unexpected end of input') ||
        error.message.includes('Invalid or unexpected token')
      ) {
        this.logger.warn(`[TASK_${taskId}] Syntax error: ${error.message}`);
      } else if (
        error.message.includes('Failed to fetch') ||
        (error.message.includes('TypeError') && error.message.includes('fetch'))
      ) {
        this.logger.warn(`[TASK_${taskId}] Fetch error: ${error.message}`);
      } else if (
        error.message.includes('Navigation timeout') ||
        error.message.includes('Navigation failed') ||
        error.message.includes('Navigation timeout after form submission')
      ) {
        this.logger.warn(`[TASK_${taskId}] Navigation error: ${error.message}`);
      } else {
        this.logger.error(`[TASK_${taskId}] Error in Puppeteer task: ${error.message}`, error);
      }
    } finally {
      const taskDuration = Date.now() - taskStartTime;
      this.logger.info(`[TASK_${taskId}] ⏱️ Task completed in ${taskDuration}ms, releasing page`);

      if (finalPage && !finalPage.isClosed()) {
        this.logger.debug(`[TASK_${taskId}] Releasing finalPage for geo=${geo}`);
        await this.puppeteerService.releasePage(finalPage, geo as CountryCode);
      } else if (page && !page.isClosed()) {
        this.logger.debug(`[TASK_${taskId}] Releasing original page for geo=${geo}`);
        await this.puppeteerService.releasePage(page, geo as CountryCode);
      } else {
        this.logger.debug(`[TASK_${taskId}] No page to release, both pages are closed`);
      }

      await this.updateTaskStatistics(task._id.toString(), afterSubmitUrl || finalRedirectUrl);
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
      if (
        e.message.includes('Navigation timeout') ||
        e.message.includes('Navigation failed') ||
        e.message.includes('Navigation timeout after form submission') ||
        e.message.includes('net::ERR_') ||
        e.message.includes('ERR_TUNNEL_CONNECTION_FAILED')
      ) {
        this.logger.warn(`${taskPrefix} Navigation error in tryClickRedirectLink: ${e.message}`);
      } else {
        this.logger.warn(`${taskPrefix} Error in tryClickRedirectLink: ${e.message}`);
      }
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
      if (
        error.message.includes('SyntaxError') ||
        error.message.includes('Unexpected token') ||
        error.message.includes('Unexpected identifier') ||
        error.message.includes('Unexpected end of input') ||
        error.message.includes('Invalid or unexpected token')
      ) {
        this.logger.warn(`[TASK_UNKNOWN] Syntax error in action: ${error.message}`);
        return null;
      }
      if (
        error.message.includes('Failed to fetch') ||
        (error.message.includes('TypeError') && error.message.includes('fetch'))
      ) {
        this.logger.warn(`[TASK_UNKNOWN] Fetch error in action: ${error.message}`);
        return null;
      }
      if (
        error.message.includes('Navigation timeout') ||
        error.message.includes('Navigation failed') ||
        error.message.includes('Navigation timeout after form submission') ||
        error.message.includes('net::ERR_') ||
        error.message.includes('ERR_TUNNEL_CONNECTION_FAILED')
      ) {
        this.logger.warn(`[TASK_UNKNOWN] Navigation error in action: ${error.message}`);
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
          // ...existing code...

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
    geo?: CountryCode,
  ): Promise<string | null> {
    const taskPrefix = taskId ? `[TASK_${taskId}]` : '[TASK_UNKNOWN]';

    this.logger.info(`${taskPrefix} Available lead data: ${JSON.stringify(leadData)}`);

    if (page.isClosed()) {
      this.logger.warn(`${taskPrefix} Page is closed, skipping form filling`);
      return null;
    }

    try {
      const prePause = Math.random() * 3_000;
      this.logger.info(`${taskPrefix} Pause before filling form: ${prePause.toFixed(0)}ms`);
      await this.sleep(prePause);
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
            (window as any).__lastRandomClick = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
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

      await page.evaluate(() => {
        const forms = document.querySelectorAll('form');
        if (forms.length > 0) {
          forms[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });

      await this.sleep(1_000 + Math.random() * 1_000);

      const beforeSubmitUrl = page.url();

      if (isQuiz) {
        this.logger.info(
          `${taskPrefix} This is a quiz task, using JavaScript code generation approach`,
        );
        try {
          const formsHtml = await this.aiService.extractFormHtml(page);
          if (!formsHtml.trim()) {
            this.logger.warn(`${taskPrefix} No forms found on the page`);
            throw new Error(
              `${taskPrefix} No forms found on the page, cannot proceed with form filling`,
            );
          }

          const jsCode = await this.aiService.generateFormFillScript(formsHtml, leadData);
          this.logger.info(`${taskPrefix} Generated JavaScript code for quiz form filling`);

          await page.evaluate(jsCode);
          this.logger.info(`${taskPrefix} Executed JavaScript code for quiz form filling`);
        } catch (quizError) {
          this.logger.error(
            `${taskPrefix} Quiz form filling failed: ${quizError.message}, falling back to regular method`,
          );
        }
      } else {
        let analysis;

        try {
          const formsHtml = await this.aiService.extractFormHtml(page);
          if (!formsHtml.trim()) {
            this.logger.warn(`${taskPrefix} No forms found on the page`);
            throw new Error(
              `${taskPrefix} No forms found on the page, cannot proceed with form filling`,
            );
          }
          analysis = await this.aiService.analyzeForms(formsHtml);
        } catch (aiError) {
          this.logger.warn(
            `${taskPrefix} AI analysis failed: ${aiError.message}, trying fallback method`,
          );
          try {
            analysis = await this.aiService.analyzeFormsFallback(page);
          } catch (fallbackError) {
            this.logger.error(
              `${taskPrefix} Both AI and fallback analysis failed: ${fallbackError.message}`,
            );
            return;
          }
        }

        if (!analysis.bestForm || analysis.bestForm.fields.length === 0) {
          this.logger.warn(`${taskPrefix} Could not identify suitable form fields`);
          return;
        }

        this.logger.info(
          `${taskPrefix} Selected form #${analysis.bestForm.formIndex} with ${analysis.bestForm.fields.length} fields`,
        );

        await page.evaluate((formIndex) => {
          const forms = Array.from(document.querySelectorAll('form'));
          const form = forms[formIndex];
          if (form) {
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, analysis.bestForm.formIndex);
        await this.sleep(1_500 + Math.random() * 1_000);

        for (const field of analysis.bestForm.fields) {
          if (page.isClosed()) {
            this.logger.warn(`${taskPrefix} Page is closed, stopping form filling`);
            return;
          }
          let value = '';
          switch (field.type) {
            case 'name':
              value = leadData.name;
              break;
            case 'surname':
              value = leadData.lastname;
              break;
            case 'phone':
              value = leadData.phone;
              break;
            case 'email':
              value = leadData.email;
              break;
          }

          if (!value) {
            this.logger.error(`${taskPrefix} No value for field type: ${field.type}, skipping`);
            throw new Error(
              `${taskPrefix} No value for field type: ${field.type}, cannot fill form`,
            );
          }

          try {
            const fieldExists = await page.evaluate((selector) => {
              const element = document.querySelector(selector) as HTMLInputElement;
              if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return true;
              }
              return false;
            }, field.selector);
            if (!fieldExists) {
              this.logger.warn(`${taskPrefix} Field not found: ${field.selector}, skipping`);
              continue;
            }
            await this.sleep(500 + Math.random() * 500);

            await this.simulateMouseMovement(page, field.selector, taskId);

            if (Math.random() < 0.2) {
              await this.sleep(600 + Math.random() * 800);
            }

            const typingConfig = this.getTypingConfig(field.type);
            await this.fillFieldWithTyping(page, field.selector, value, typingConfig);

            this.logger.info(
              `${taskPrefix} ✅ Filled field ${field.selector} (${field.type}) with value: ${value} (confidence: ${field.confidence})`,
            );

            await this.simulateFieldTransition(page);
          } catch (error) {
            this.logger.warn(
              `${taskPrefix} Failed to fill field ${field.selector}: ${error.message}`,
            );
          }
        }

        this.logger.info(
          `${taskPrefix} All fields filled; URL before form submission: ${beforeSubmitUrl}`,
        );
        await this.sleep(1_000 + Math.random() * 1_000);

        if (analysis.bestForm.checkboxes?.length) {
          for (const cb of analysis.bestForm.checkboxes) {
            try {
              const isChecked = await page.evaluate((sel) => {
                const el = document.querySelector(sel) as HTMLInputElement;
                return el?.checked === true;
              }, cb.selector);

              if (!isChecked) {
                await this.simulateMouseMovement(page, cb.selector, taskId);
                await this.sleep(300 + Math.random() * 700);
                await page.evaluate((sel) => {
                  const el = document.querySelector(sel) as HTMLInputElement;
                  el?.click();
                }, cb.selector);

                this.logger.info(
                  `${taskPrefix} ✅ Checked checkbox ${cb.selector}` +
                    (cb.label ? ` (${cb.label})` : '') +
                    ` — confidence: ${cb.confidence}`,
                );

                await this.sleep(400 + Math.random() * 600);
              }
            } catch (err) {
              this.logger.warn(
                `${taskPrefix} Failed to check checkbox ${cb.selector}: ${err.message}`,
              );
            }
          }
        }

        await this.takeScreenshot(page, taskId, 'after-form-fill');

        const submitResult = await page.evaluate((formIndex) => {
          const forms = Array.from(document.querySelectorAll('form'));
          const form = forms[formIndex];
          if (!form) return 'form_not_found';
          let submitButton = form.querySelector('button[type="submit"], input[type="submit"]') as
            | HTMLButtonElement
            | HTMLInputElement;
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
            }) as HTMLButtonElement;
          }
          if (submitButton && (submitButton as HTMLElement).offsetParent !== null) {
            (submitButton as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(
              () => {
                (submitButton as HTMLElement).click();
              },
              1_000 + Math.random() * 1_000,
            );
            return 'clicked_submit_button';
          } else {
            setTimeout(
              () => {
                form.submit();
              },
              1_000 + Math.random() * 1_000,
            );
            return 'called_form_submit';
          }
        }, analysis.bestForm.formIndex);
        this.logger.info(`${taskPrefix} 🎉 Form submit result: ${submitResult}`);
      }

      await this.sleep(2_000 + Math.random() * 1_000);

      const navigationResult = await this.waitForNavigationReliable(
        page,
        taskPrefix,
        beforeSubmitUrl,
        geo,
      );
      let { navigationDetected, afterUrl: afterSubmitUrl } = navigationResult;

      await this.sleep(45_000);

      await this.takeScreenshot(page, taskId, 'thank-you');

      // Final URL check
      const finalUrl = page.url();
      if (finalUrl !== beforeSubmitUrl) {
        afterSubmitUrl = finalUrl;
        navigationDetected = true;
        this.logger.info(`${taskPrefix} ✅ Final URL change detected: ${afterSubmitUrl}`);
      }

      if (!navigationDetected) {
        this.logger.info(`${taskPrefix} ℹ️ No navigation detected, but form submission completed`);
      }

      return afterSubmitUrl;
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
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

  private async waitForNavigationReliable(
    page: Page,
    taskPrefix: string,
    beforeUrl: string,
    geo?: CountryCode,
  ): Promise<{ navigationDetected: boolean; afterUrl: string }> {
    let navigationDetected = false;
    let afterUrl = beforeUrl;

    try {
      await page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: 3_000,
      });
      navigationDetected = true;
      afterUrl = page.url();
      this.logger.info(`${taskPrefix} ✅ Immediate navigation detected: ${afterUrl}`);
      return { navigationDetected, afterUrl };
    } catch {
      this.logger.debug(`${taskPrefix} No immediate navigation, trying alternative methods...`);
    }

    await this.sleep(2_000);
    const currentUrl = page.url();
    if (currentUrl !== beforeUrl) {
      navigationDetected = true;
      afterUrl = currentUrl;
      this.logger.info(`${taskPrefix} ✅ Delayed URL change detected: ${afterUrl}`);
      return { navigationDetected, afterUrl };
    }

    if (geo) {
      try {
        const successIndicators = await checkSuccessIndicators(page, geo);
        if (successIndicators.hasSuccessIndicators) {
          this.logger.info(
            `${taskPrefix} ✅ Success indicators found for geo ${geo}: ${successIndicators.indicators.join(', ')}`,
          );
          navigationDetected = true;
          return { navigationDetected, afterUrl };
        }
      } catch (indicatorError) {
        this.logger.debug(
          `${taskPrefix} Error checking success indicators: ${indicatorError.message}`,
        );
      }
    }

    await this.sleep(3_000);
    const finalUrl = page.url();
    if (finalUrl !== beforeUrl) {
      navigationDetected = true;
      afterUrl = finalUrl;
      this.logger.info(`${taskPrefix} ✅ Final URL change detected: ${afterUrl}`);
      return { navigationDetected, afterUrl };
    }

    this.logger.info(`${taskPrefix} ℹ️ No navigation detected, but form submission completed`);
    return { navigationDetected: false, afterUrl };
  }

  async getQueueStatistics(): Promise<{
    queueLength: number;
    activeTaskCount: number;
    maxConcurrentTasks: number;
    isProcessing: boolean;
  }> {
    return {
      queueLength: this.taskQueue.length,
      activeTaskCount: this.activeTaskCount,
      maxConcurrentTasks: this.MAX_CONCURRENT_TASKS,
      isProcessing: this.isProcessingQueue,
    };
  }

  async forceProcessQueue(): Promise<void> {
    this.logger.info(`[TASK_PROCESSOR] 🔄 Force processing queue...`);
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }
}
