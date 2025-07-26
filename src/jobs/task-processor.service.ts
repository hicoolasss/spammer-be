import { CountryCode, TaskStatus } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { LogWrapper } from '@utils';
import { getRandomItem } from '@utils';
import { Model } from 'mongoose';
import { Browser, Page } from 'puppeteer';

import { AIService } from '../ai/ai.service';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { RedisService } from '../redis/redis.service';

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

      this.logger.info(`Found ${activeTasks.length} active tasks to process`);

      for (const task of activeTasks) {
        void this.processTasks(task._id.toString()).catch((e) => {
          this.logger.error(`Error processing task ${task._id}: ${e.message}`);
        });
      }
    } catch (error) {
      this.logger.error(`Error processing active tasks: ${error.message}`, error);
    }
  }

  async processTasks(taskId: string): Promise<void> {
    try {
      const task = await this.taskModel.findById(taskId).exec();

      if (!task) {
        this.logger.error(`Task with ID ${taskId} not found`);
        return;
      }

      if (task.isRunning) {
        this.logger.warn(`Task ${taskId} is already running, skipping`);
        return;
      }

      task.isRunning = true;
      await task.save();

      try {
        await this.processTask(task);
      } finally {
        task.isRunning = false;
        await task.save();
      }
    } catch (error) {
      this.logger.error(`Error processing task: ${error.message}`, error);
    }
  }

  private async processTask(task: TaskDocument): Promise<void> {
    const { _id, url, profileId, geo } = task;

    try {
      this.logger.debug(`[DEBUG] processTask: _id=${_id}, url=${url}, profileId=${profileId}, geo=${geo}`);
      const profile = await this.geoProfileModel.findById(profileId).exec();

      if (!profile) {
        this.logger.error(`Profile with ID ${profileId} not found`);
        return;
      }
      this.logger.debug(`[DEBUG] Loaded profile: ${JSON.stringify(profile)}`);

      const { leadKey, fbclidKey, userAgentKey } = profile;
      const leads = (await this.redisService.getLeadsBatch(leadKey, 1)) || [];

      if (leads.length === 0) {
        this.logger.info('No more leads available...');
        return;
      }

      const userAgents = (await this.redisService.getUserAgentsBatch(userAgentKey, 1)) || [];
      const fbclids = (await this.redisService.getFbclidsBatch(fbclidKey, 1)) || [];
      const leadData = leads[0];
      const userAgent = getRandomItem(userAgents);
      const fbclid = getRandomItem(fbclids);

      let finalUrl = url;

      if (fbclid) {
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl = finalUrl + separator + 'fbclid=' + fbclid;
      }

      this.logger.debug(`[DEBUG] finalUrl: ${finalUrl}`);
      this.logger.debug(`[DEBUG] userAgent: ${userAgent}`);
      this.logger.debug(`[DEBUG] geo: ${geo}`);
      this.logger.info(`Processing lead for task ${_id}: ${JSON.stringify(leadData)}`);
      this.logger.info(`Using userAgent: ${userAgent}, fbclid: ${fbclid}`);
      const TIMEOUT_MS = 3 * 60 * 1000;
      this.logger.debug(`[DEBUG] Calling runPuppeteerTask with geo=${geo}, userAgent=${userAgent}, url=${finalUrl}`);
      await withTimeout(
        this.runPuppeteerTask(task, leadData, userAgent, false),
        TIMEOUT_MS,
        () => this.logger.error('Task timed out, closing slot'),
      );

      await this.taskModel.findByIdAndUpdate(_id, { lastRunAt: new Date() });
      this.logger.info(`Task ${_id} completed. Updated lastRunAt.`);
    } catch (error) {
      this.logger.error(`[DEBUG] Error processing task: ${error.message}, stack: ${error.stack}`);
      this.logger.error(`[DEBUG] Error context: taskId=${_id}, profileId=${profileId}, geo=${geo}`);
      this.logger.error(`Error processing task: ${error.message}`, error);
    }
  }

  private async updateTaskStatistics(taskId: string, finalRedirectUrl: string | null): Promise<void> {
    try {
      const task = await this.taskModel.findById(taskId).exec();
      if (!task) {
        this.logger.error(`Task with ID ${taskId} not found for statistics update`);
        return;
      }

      task.result.total = (task.result?.total || 0) + 1;

      if (!task.result.success) {
        task.result.success = {};
      }

      if (finalRedirectUrl && finalRedirectUrl !== task.url) {
        const redirectKey = finalRedirectUrl;
        const currentCount = (task.result.success as Record<string, number>)[redirectKey] || 0;
        (task.result.success as Record<string, number>)[redirectKey] = currentCount + 1;
        
        this.logger.info(`Task ${taskId} successful redirect to: ${finalRedirectUrl}`);
      }

      await task.save();
      this.logger.info(`Updated statistics for task ${taskId}: total=${task.result.total}, success=${JSON.stringify(task.result.success)}`);
    } catch (error) {
      this.logger.error(`Error updating task statistics: ${error.message}`, error);
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
        timeout: 60000,
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
    leadData: LeadData,
    userAgent: string,
    humanize = false,
  ): Promise<void> {
    const { url, geo, shouldClickRedirectLink } = task;
    let finalRedirectUrl: string | null = null;

    let page: Page | null = null;
    let finalPage: Page | null = null;

    try {
      const puppeteerPage = await this.puppeteerService.acquirePage(
        'task-processor',
        geo as CountryCode,
        userAgent,
      );
      page = puppeteerPage;

      this.logger.info(`Navigating to: ${url}`);

      const { page: resolvedPage, effectiveUrl } = await this.getFinalEffectivePage(
        page.browser(),
        page,
        url,
      );
      finalPage = resolvedPage;

      if (finalPage.isClosed()) {
        this.logger.warn('Page was closed during navigation');
        return;
      }

      if (shouldClickRedirectLink) {
        this.logger.info(
          'shouldClickRedirectLink=true: ищем ссылку для редиректа после загрузки страницы',
        );
        await this.tryClickRedirectLink(finalPage);
        await this.tryClickProceedButton(finalPage);
      }

      await this.safeExecute(finalPage, () => this.simulateRandomClicks(finalPage, humanize));
      await this.safeExecute(finalPage, () => this.simulateScrolling(finalPage, humanize));
      await this.safeExecute(finalPage, () => this.findAndOpenForm(finalPage));
      await this.safeExecute(finalPage, () => this.fillFormWithData(finalPage, leadData, humanize));

      if (effectiveUrl.includes('facebook.com/flx/warn')) {
        try {
          await finalPage.waitForSelector('a[role="button"], button[role="button"]', {
            timeout: 10000,
          });
          const clicked = await finalPage.evaluate(() => {
            const buttons = Array.from(
              document.querySelectorAll('a[role="button"], button[role="button"]'),
            );
            const target = buttons.find(
              (btn) =>
                btn.textContent &&
                (btn.textContent.toLowerCase().includes('перейти за посиланням') ||
                  btn.textContent.toLowerCase().includes('follow link')),
            );
            if (target) {
              (window as any).__clickedLink = {
                href: target.getAttribute('href'),
                text: target.textContent?.trim(),
              };
              (target as HTMLElement).click();
              return true;
            }
            if (buttons.length > 1) {
              (buttons[1] as HTMLElement).click();
              return true;
            }
            return false;
          });
          if (clicked) {
            await finalPage
              .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
              .catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 5000));
            this.logger.info('Clicked Facebook warning button and waited for navigation.');
          } else {
            this.logger.warn(
              'Не удалось найти кнопку "Перейти за посиланням" на Facebook warning.',
            );
          }
        } catch (e) {
          this.logger.warn(
            'Не удалось кликнуть по кнопке Facebook warning или дождаться перехода: ' + e.message,
          );
        }
      }

      if (!finalPage.isClosed()) {
        finalRedirectUrl = finalPage.url();
        this.logger.info(`Final redirect URL: ${finalRedirectUrl}`);
      }
    } catch (error) {
      this.logger.error(`Error in Puppeteer task: ${error.message}`, error);
    } finally {
      if (finalPage && !finalPage.isClosed()) {
        await this.puppeteerService.releasePage(finalPage, geo as CountryCode);
      } else if (page && !page.isClosed()) {
        await this.puppeteerService.releasePage(page, geo as CountryCode);
      }
    }

    await this.updateTaskStatistics(task._id.toString(), finalRedirectUrl);
  }

  private async tryClickRedirectLink(page: Page) {
    try {
      const beforeUrl = page.url();
      const result = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const debugLinks = links.map((a) => ({
          href: a.getAttribute('href'),
          text: a.textContent?.trim(),
        }));

        (window as any).__debugLinks = debugLinks;
        const target = links.find((a) => {
          const href = a.getAttribute('href') || '';
          return (
            (href.startsWith('http') && !href.includes(window.location.hostname)) ||
            a.getAttribute('target') === '_blank'
          );
        });
        if (target) {
          (window as any).__clickedLink = {
            href: target.getAttribute('href'),
            text: target.textContent?.trim(),
          };
          (target as HTMLElement).click();
          return true;
        }
        return false;
      });
      const debugLinks = (await page.evaluate('window.__debugLinks')) as Array<{
        href: string;
        text: string;
      }>;
      this.logger.info(`[tryClickRedirectLink] Найдено ссылок: ${debugLinks.length}`);
      debugLinks.forEach((l, i) =>
        this.logger.info(`[tryClickRedirectLink] [${i}] href=${l.href} text=${l.text}`),
      );
      if (result) {
        const clicked = (await page.evaluate('window.__clickedLink')) as {
          href: string;
          text: string;
        };
        this.logger.info(
          `[tryClickRedirectLink] Клик по ссылке: href=${clicked.href} text=${clicked.text}`,
        );
        await page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => {});
        const afterUrl = page.url();
        this.logger.info(`[tryClickRedirectLink] URL до: ${beforeUrl}, после: ${afterUrl}`);
      } else {
        this.logger.warn(
          '[tryClickRedirectLink] Не удалось найти ссылку для редиректа на странице.',
        );
      }
    } catch (e) {
      this.logger.warn('Ошибка при попытке кликнуть по ссылке для редиректа: ' + e.message);
    }
  }

  private async tryClickProceedButton(page: Page) {
    try {
      const beforeUrl = page.url();
      const result = await page.evaluate(() => {
        const texts = ['перейти', 'далее', 'continue', 'next', 'go', 'продовжити', 'продолжить'];
        const buttons = Array.from(
          document.querySelectorAll(
            'button, a[role="button"], input[type=button], input[type=submit]',
          ),
        );
        // @ts-ignore
        window.__debugButtons = buttons.map((btn) => {
          let text = '';
          if ('value' in btn) {
            text = (btn as HTMLInputElement).value || '';
          } else {
            text = btn.textContent || '';
          }
          return { text: text.trim(), tag: btn.tagName, class: btn.className };
        });
        const target = buttons.find((btn) => {
          let text = '';
          if ('value' in btn) {
            text = (btn as HTMLInputElement).value || '';
          } else {
            text = btn.textContent || '';
          }
          text = text.toLowerCase();
          return texts.some((t) => text.includes(t));
        });
        if (target) {
          // @ts-ignore
          window.__clickedButton = {
            text: (target.textContent || (target as HTMLInputElement).value || '').trim(),
            tag: target.tagName,
            class: target.className,
          };
          (target as HTMLElement).click();
          return true;
        }
        return false;
      });
      const debugButtons = (await page.evaluate('window.__debugButtons')) as Array<{
        tag: string;
        class: string;
        text: string;
      }>;
      this.logger.info(`[tryClickProceedButton] Найдено кнопок: ${debugButtons.length}`);
      debugButtons.forEach((b, i) =>
        this.logger.info(
          `[tryClickProceedButton] [${i}] tag=${b.tag} class=${b.class} text=${b.text}`,
        ),
      );
      if (result) {
        const clicked = (await page.evaluate('window.__clickedButton')) as {
          tag: string;
          class: string;
          text: string;
        };
        this.logger.info(
          `[tryClickProceedButton] Клик по кнопке: tag=${clicked.tag} class=${clicked.class} text=${clicked.text}`,
        );
        await page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => {});
        const afterUrl = page.url();
        this.logger.info(`[tryClickProceedButton] URL до: ${beforeUrl}, после: ${afterUrl}`);
      } else {
        this.logger.warn(
          '[tryClickProceedButton] Не удалось найти кнопку "Перейти/Далее/Continue/Next" на сайте.',
        );
      }
    } catch (e) {
      this.logger.warn('Ошибка при попытке кликнуть по proceed-кнопке: ' + e.message);
    }
  }

  private async safeExecute(page: Page, action: () => Promise<void>): Promise<void> {
    try {
      if (page.isClosed()) {
        this.logger.warn('Page is closed, skipping action');
        return;
      }
      await action();
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed') ||
        error.message.includes('Session closed')
      ) {
        this.logger.warn('Page context was destroyed, skipping action');
        return;
      }
      this.logger.error(`Error executing action: ${error.message}`);
    }
  }

  private async simulateScrolling(
    page: Page,
    humanize = false,
    shouldClickRedirectLink = false,
  ): Promise<void> {
    this.logger.info('Simulating natural scrolling...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping scrolling');
      return;
    }

    try {
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);
      const viewportHeight = await page.evaluate(() => window.innerHeight);

      this.logger.info(`Page height: ${pageHeight}px, Viewport height: ${viewportHeight}px`);

      const scrollSteps = Math.ceil(pageHeight / viewportHeight);

      for (let i = 0; i < scrollSteps; i++) {
        if (page.isClosed()) break;

        const scrollAmount = Math.floor(Math.random() * 200) + 300;

        await page.evaluate((amount) => {
          window.scrollBy({
            top: amount,
            behavior: 'smooth',
          });
        }, scrollAmount);

        const pauseTime = 800 + Math.random() * 1200;
        await new Promise((resolve) => setTimeout(resolve, pauseTime));

        if (shouldClickRedirectLink) {
          await this.tryClickRedirectLink(page);
        }

        if (humanize && Math.random() < 0.2) {
          await page.evaluate(() => {
            window.scrollBy({
              top: -100 - Math.random() * 200,
              behavior: 'smooth',
            });
          });
          await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 700));
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));

      if (!page.isClosed()) {
        await page.evaluate(() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1000));
      }

      this.logger.info('Natural scrolling completed');
    } catch (error) {
      if (error.message.includes('Execution context was destroyed')) {
        this.logger.warn('Page context destroyed during scrolling');
        return;
      }
      throw error;
    }
  }

  private async simulateRandomClicks(page: Page, humanize = false): Promise<void> {
    this.logger.info('Simulating natural clicks and navigation...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping random clicks');
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

      this.logger.info(`Found ${clickableElements.length} clickable elements`);

      if (humanize && clickableElements.length > 0) {
        const randomClicks = Math.floor(Math.random() * 2) + 1;
        for (let i = 0; i < randomClicks; i++) {
          const el = clickableElements[Math.floor(Math.random() * clickableElements.length)];
          this.logger.info(
            `(Humanize) Randomly clicking on ${el.tagName}: "${el.text}" (${el.href})`,
          );
          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) el.click();
            },
            `${el.tagName}${el.href ? `[href="${el.href}"]` : ''}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 2000));
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
          this.logger.info(`Clicking on ${element.tagName}: "${element.text}" (${element.href})`);

          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) {
                el.click();
              }
            },
            `${element.tagName}${element.href ? `[href="${element.href}"]` : ''}`,
          );

          await new Promise((resolve) => setTimeout(resolve, 2500 + Math.random() * 2500));

          if (element.href && !element.href.startsWith('#')) {
            this.logger.info('Waiting for page navigation...');
            await page
              .waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
              .catch(() => {
                this.logger.warn('Page navigation timeout');
              });

            await new Promise((resolve) => setTimeout(resolve, 4000 + Math.random() * 5000));
          }
        } catch (error) {
          this.logger.warn(`Failed to click element: ${error.message}`);
        }
      }

      this.logger.info('Natural clicking and navigation completed');
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        this.logger.warn('Page context destroyed during random clicks');
        return;
      }
      throw error;
    }
  }

  private async findAndOpenForm(page: Page): Promise<void> {
    this.logger.info('🔍 Looking for forms on the page...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping form search');
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
        this.logger.warn('❌ No forms found on the page');
        return;
      }

      this.logger.info(`📋 Found ${formInfo.length} form(s) on the page:`);
      formInfo.forEach((form) => {
        this.logger.info(
          `  Form #${form.index}: ${form.visibleInputs} visible inputs, action: ${form.action}`,
        );
      });

      const bestForm = formInfo.find((form) => form.visibleInputs > 0) || formInfo[0];

      if (bestForm) {
        this.logger.info(`🎯 Selected form #${bestForm.index} for interaction`);

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
            }, 3000);
          }
        }, bestForm.index);

        await new Promise((resolve) => setTimeout(resolve, 2000));

        this.logger.info('✅ Form search completed - AI will analyze forms during filling');
      }
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        this.logger.warn('Page context destroyed during form search');
        return;
      }
      this.logger.error(`Error finding form: ${error.message}`);
    }
  }

  private async fillFormWithData(page: Page, leadData: LeadData, humanize = false): Promise<void> {
    this.logger.info('Filling form with lead data using AI analysis...');
    this.logger.info(`Available lead data: ${JSON.stringify(leadData)}`);

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping form filling');
      return;
    }

    try {
      await page.evaluate(() => {
        const forms = document.querySelectorAll('form');
        if (forms.length > 0) {
          forms[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));

      const formsHtml = await this.aiService.extractFormHtml(page);

      if (!formsHtml.trim()) {
        this.logger.warn('No forms found on the page');
        return;
      }

      const analysis = await this.aiService.analyzeForms(formsHtml);

      if (!analysis.bestForm || analysis.bestForm.fields.length === 0) {
        this.logger.warn('AI could not identify suitable form fields');
        return;
      }

      this.logger.info(
        `AI selected form #${analysis.bestForm.formIndex} with ${analysis.bestForm.fields.length} fields`,
      );
      this.logger.info(
        `AI confidence: ${analysis.bestForm.confidence}, reason: ${analysis.bestForm.reason}`,
      );

      await page.evaluate((formIndex) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms[formIndex];
        if (form) {
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, analysis.bestForm.formIndex);
      await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1000));

      for (const field of analysis.bestForm.fields) {
        if (page.isClosed()) {
          this.logger.warn('Page is closed, stopping form filling');
          return;
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
        }

        if (!value) {
          this.logger.warn(`No value for field type: ${field.type}, skipping`);
          continue;
        }

        try {
          await page.evaluate((selector) => {
            const element = document.querySelector(selector) as HTMLElement;
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, field.selector);
          await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));

          if (humanize) {
            for (let i = 0; i < value.length; i++) {
              await page.evaluate(
                (selector, char) => {
                  const element = document.querySelector(selector) as HTMLInputElement;
                  if (element) {
                    element.focus();
                    element.value += char;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                },
                field.selector,
                value[i],
              );
              await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));
            }
          } else {
            await page.evaluate(
              (selector, value) => {
                const element = document.querySelector(selector) as HTMLInputElement;
                if (element) {
                  element.focus();
                  element.value = value;
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                }
              },
              field.selector,
              value,
            );
          }

          this.logger.info(
            `✅ Filled field ${field.selector} (${field.type}) with value: ${value} (confidence: ${field.confidence})`,
          );

          const pauseTime = 600 + Math.random() * 1200;
          await new Promise((resolve) => setTimeout(resolve, pauseTime));
        } catch (error) {
          this.logger.warn(`Failed to fill field ${field.selector}: ${error.message}`);
        }
      }

      this.logger.info('All fields filled, preparing to submit form...');
      await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 2000));

      const beforeSubmitUrl = page.url();
      this.logger.info(`URL before form submission: ${beforeSubmitUrl}`);

      const submitResult = await page.evaluate((formIndex) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms[formIndex];
        if (!form) return 'form_not_found';

        const submitButton = form.querySelector('button[type="submit"], input[type="submit"]') as
          | HTMLButtonElement
          | HTMLInputElement;

        if (submitButton && submitButton.offsetParent !== null) {
          setTimeout(
            () => {
              submitButton.click();
            },
            1000 + Math.random() * 1000,
          );

          return 'clicked_submit_button';
        } else {
          setTimeout(
            () => {
              form.submit();
            },
            1000 + Math.random() * 1000,
          );
          return 'called_form_submit';
        }
      }, analysis.bestForm.formIndex);

      this.logger.info(`🎉 Form submit result: ${submitResult}`);

      try {
        await page.waitForNavigation({ 
          waitUntil: 'domcontentloaded', 
          timeout: 15000 
        }).catch(() => {
          this.logger.warn('Navigation timeout after form submission');
        });
        
        const afterSubmitUrl = page.url();
        this.logger.info(`URL after form submission: ${afterSubmitUrl}`);
        
        if (afterSubmitUrl !== beforeSubmitUrl) {
          this.logger.info(`Form submission successful! Redirected to: ${afterSubmitUrl}`);
        } else {
          this.logger.info('Form submitted but no navigation detected');
        }
      } catch (error) {
        this.logger.warn(`Error waiting for navigation after form submission: ${error.message}`);
      }

      this.logger.info('AI-powered form filling completed successfully!');
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        this.logger.warn('Page context destroyed during form filling');
        return;
      }
      this.logger.error(`Error filling form with AI: ${error.message}`, error);
    }
  }
}
