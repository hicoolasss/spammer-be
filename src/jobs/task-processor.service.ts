import { CountryCode, TaskStatus } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { LogWrapper } from '@utils';
import { getRandomItem } from '@utils';
import { Model } from 'mongoose';
import { Page } from 'puppeteer';

import { AIService } from '../ai/ai.service';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { RedisService } from '../redis/redis.service';

class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const resolve = this.waitQueue.shift()!;
      resolve();
    } else {
      this.permits++;
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
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
      const activeTasks = await this.taskModel
        .find({ status: TaskStatus.ACTIVE })
        .exec();

      this.logger.info(`Found ${activeTasks.length} active tasks to process`);

      for (const task of activeTasks) {
        void this.processTasks(task._id.toString()).catch((e) => {
          this.logger.error(`Error processing task ${task._id}: ${e.message}`);
        });
      }
    } catch (error) {
      this.logger.error(
        `Error processing active tasks: ${error.message}`,
        error,
      );
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

  private async processTask({ _id, url, profileId, geo }): Promise<void> {
    try {
      const profile = await this.geoProfileModel.findById(profileId).exec();

      if (!profile) {
        this.logger.error(`Profile with ID ${profileId} not found`);
        return;
      }

      const { leadKey, fbclidKey, userAgentKey } = profile;
      const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;

      let iterations = 0;
      let processedCount = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const leads =
          (await this.redisService.getLeadsBatch(leadKey, MAX_TABS)) || [];

        if (leads.length === 0) {
          this.logger.info('No more leads available...');
          await new Promise((resolve) => setTimeout(resolve, 30000));
          break;
        }

        const userAgents =
          (await this.redisService.getUserAgentsBatch(
            userAgentKey,
            MAX_TABS,
          )) || [];
        const fbclids =
          (await this.redisService.getFbclidsBatch(fbclidKey, MAX_TABS)) || [];

        if (!userAgents.length) {
          this.logger.warn('No userAgents found for this batch');
        }
        if (!fbclids.length) {
          this.logger.warn('No fbclids found for this batch');
        }

        const shuffledLeads = leads.sort(() => Math.random() - 0.5);
        this.logger.info(
          `Processing batch ${iterations + 1}: ${leads.length} leads`,
        );

        const TIMEOUT_MS = 3 * 60 * 1000;
        const semaphore = new Semaphore(50);
        const activeTasks: Promise<void>[] = [];

        for (let index = 0; index < shuffledLeads.length; index++) {
          const leadData = shuffledLeads[index];
          const userAgent = getRandomItem(userAgents);
          const fbclid = getRandomItem(fbclids);
          const finalUrl = url + '?&fbclid=' + (fbclid || 'null');

          this.logger.info(
            `Processing lead ${processedCount + index + 1}: ${JSON.stringify(leadData)}`,
          );

          this.logger.info(`Using userAgent: ${userAgent}, fbclid: ${fbclid}`);

          await semaphore.acquire();

          const taskPromise = withTimeout(
            this.runPuppeteerTask(finalUrl, geo, leadData, userAgent, false),
            TIMEOUT_MS,
            () => this.logger.error('Task timed out, closing slot'),
          )
            .catch((e) =>
              this.logger.error(`Error processing lead: ${e.message}`),
            )
            .finally(() => {
              semaphore.release();
            });

          activeTasks.push(taskPromise);

          activeTasks.forEach((task) => {
            if (task.then) {
              task
                .then(() => {
                  const idx = activeTasks.indexOf(task);
                  if (idx > -1) {
                    activeTasks.splice(idx, 1);
                  }
                })
                .catch(() => {
                  const idx = activeTasks.indexOf(task);
                  if (idx > -1) {
                    activeTasks.splice(idx, 1);
                  }
                });
            }
          });
        }

        if (
          activeTasks.length < shuffledLeads.length &&
          activeTasks.length > 0
        ) {
          await Promise.allSettled(activeTasks);
        }

        iterations++;
        processedCount += leads.length;

        this.logger.info(
          `Completed batch ${iterations}. Total processed: ${processedCount}`,
        );
      }

      this.logger.info(
        `Task ${_id} completed. Processed ${processedCount} leads in ${iterations} iterations`,
      );
    } catch (error) {
      this.logger.error(`Error processing task: ${error.message}`, error);
    }
  }

  private async runPuppeteerTask(
    url: string,
    geo: string,
    leadData: LeadData,
    userAgent: string,
    humanize = false,
  ): Promise<void> {
    console.log(`Running Puppeteer task for URL: ${url}, Geo: ${geo}`);
    let page: Page | null = null;

    try {
      const puppeteerPage = await this.puppeteerService.acquirePage(
        'task-processor',
        geo as CountryCode,
        userAgent,
      );
      page = puppeteerPage;

      this.logger.info(`Navigating to: ${url}`);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      await new Promise((resolve) =>
        setTimeout(resolve, 2000 + Math.random() * 3000),
      );

      if (page.isClosed()) {
        this.logger.warn('Page was closed during navigation');
        return;
      }

      await this.safeExecute(page, () =>
        this.simulateScrolling(page, humanize),
      );
      await this.safeExecute(page, () =>
        this.simulateRandomClicks(page, humanize),
      );
      await this.safeExecute(page, () => this.findAndOpenForm(page));
      await this.safeExecute(page, () =>
        this.fillFormWithData(page, leadData, humanize),
      );
    } catch (error) {
      this.logger.error(`Error in Puppeteer task: ${error.message}`, error);
    } finally {
      if (page && !page.isClosed()) {
        await this.puppeteerService.releasePage(page, geo as CountryCode);
      }
    }
  }

  private async safeExecute(
    page: Page,
    action: () => Promise<void>,
  ): Promise<void> {
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

  private async simulateScrolling(page: Page, humanize = false): Promise<void> {
    this.logger.info('Simulating natural scrolling...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping scrolling');
      return;
    }

    try {
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);
      const viewportHeight = await page.evaluate(() => window.innerHeight);

      this.logger.info(
        `Page height: ${pageHeight}px, Viewport height: ${viewportHeight}px`,
      );

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

        if (humanize && Math.random() < 0.2) {
          await page.evaluate(() => {
            window.scrollBy({
              top: -100 - Math.random() * 200,
              behavior: 'smooth',
            });
          });
          await new Promise((resolve) =>
            setTimeout(resolve, 500 + Math.random() * 700),
          );
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000),
      );

      if (!page.isClosed()) {
        await page.evaluate(() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        });
        await new Promise((resolve) =>
          setTimeout(resolve, 1500 + Math.random() * 1000),
        );
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

  private async simulateRandomClicks(
    page: Page,
    humanize = false,
  ): Promise<void> {
    this.logger.info('Simulating natural clicks and navigation...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping random clicks');
      return;
    }

    try {
      const clickableElements = await page.evaluate(() => {
        const elements = Array.from(
          document.querySelectorAll(
            'a, button, [role="button"], .btn, .button',
          ),
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
          const el =
            clickableElements[
              Math.floor(Math.random() * clickableElements.length)
            ];
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
          await new Promise((resolve) =>
            setTimeout(resolve, 1200 + Math.random() * 2000),
          );
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
          this.logger.info(
            `Clicking on ${element.tagName}: "${element.text}" (${element.href})`,
          );

          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) {
                el.click();
              }
            },
            `${element.tagName}${element.href ? `[href="${element.href}"]` : ''}`,
          );

          await new Promise((resolve) =>
            setTimeout(resolve, 2500 + Math.random() * 2500),
          );

          if (element.href && !element.href.startsWith('#')) {
            this.logger.info('Waiting for page navigation...');
            await page
              .waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
              .catch(() => {
                this.logger.warn('Page navigation timeout');
              });

            await new Promise((resolve) =>
              setTimeout(resolve, 4000 + Math.random() * 5000),
            );
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
          visibleInputs: Array.from(form.querySelectorAll('input')).filter(
            (input) => {
              const style = window.getComputedStyle(input);
              return (
                input.type !== 'hidden' &&
                style.display !== 'none' &&
                style.visibility !== 'hidden'
              );
            },
          ).length,
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

      const bestForm =
        formInfo.find((form) => form.visibleInputs > 0) || formInfo[0];

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

        this.logger.info(
          '✅ Form search completed - AI will analyze forms during filling',
        );
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

  private async fillFormWithData(
    page: Page,
    leadData: LeadData,
    humanize = false,
  ): Promise<void> {
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
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000),
      );

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
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 + Math.random() * 1000),
      );

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
          await new Promise((resolve) =>
            setTimeout(resolve, 500 + Math.random() * 500),
          );

          if (humanize) {
            for (let i = 0; i < value.length; i++) {
              await page.evaluate(
                (selector, char) => {
                  const element = document.querySelector(
                    selector,
                  ) as HTMLInputElement;
                  if (element) {
                    element.focus();
                    element.value += char;
                    element.dispatchEvent(
                      new Event('input', { bubbles: true }),
                    );
                  }
                },
                field.selector,
                value[i],
              );
              await new Promise((resolve) =>
                setTimeout(resolve, 120 + Math.random() * 180),
              );
            }
          } else {
            await page.evaluate(
              (selector, value) => {
                const element = document.querySelector(
                  selector,
                ) as HTMLInputElement;
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
          this.logger.warn(
            `Failed to fill field ${field.selector}: ${error.message}`,
          );
        }
      }

      this.logger.info('All fields filled, preparing to submit form...');
      await new Promise((resolve) =>
        setTimeout(resolve, 2000 + Math.random() * 2000),
      );

      const submitResult = await page.evaluate((formIndex) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms[formIndex];
        if (!form) return 'form_not_found';

        const submitButton = form.querySelector(
          'button[type="submit"], input[type="submit"]',
        ) as HTMLButtonElement | HTMLInputElement;

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
      this.logger.info('✅ AI-powered form filling completed successfully!');
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
