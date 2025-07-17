import { CountryCode } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { getRandomItem, LogWrapper } from '@utils';
import { Model } from 'mongoose';
import { Page } from 'puppeteer';

import { AIService } from '../ai/ai.service';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { RedisService } from '../redis/redis.service';

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

  async processRandomTask(): Promise<void> {
    try {
      const mockTaskId = '686804a08e868743ae0316ad';
      const taskId = mockTaskId;

      this.logger.info(`Processing task with ID: ${taskId}`);

      const task = await this.taskModel.findById(taskId).exec();
      if (!task) {
        this.logger.error(`Task with ID ${taskId} not found`);
        return;
      }

      this.logger.info(`Found task: ${task.url}, geo: ${task.geo}`);

      const profile = await this.geoProfileModel
        .findById(task.profileId)
        .exec();
      if (!profile) {
        this.logger.error(`Profile with ID ${task.profileId} not found`);
        return;
      }

      const { leadKey, fbclidKey, userAgentKey } = profile;
      const leadData = await this.redisService.getLeadData(leadKey);
      // TODO:delete after testing
      // leadData = {
      //   ...leadData,
      //   phone: leadData.email,
      //   email: leadData.phone,
      // };
      // END
      const userAgents =
        await this.redisService.getUserAgentsData(userAgentKey);
      const fbclid = await this.redisService.getFbclidData(fbclidKey);

      const url = task.url + '?&fbclid=' + fbclid;
      const userAgent = getRandomItem(userAgents);

      await this.runPuppeteerTask(url, task.geo, leadData, userAgent);
    } catch (error) {
      this.logger.error(`Error processing task: ${error.message}`, error);
    }
  }

  private async runPuppeteerTask(
    url: string,
    geo: string,
    leadData: LeadData,
    userAgent: string,
  ): Promise<void> {
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

      if (page.isClosed()) {
        this.logger.warn('Page was closed during navigation');
        return;
      }

      await this.safeExecute(page, () => this.simulateScrolling(page));
      await this.safeExecute(page, () => this.simulateRandomClicks(page));
      await this.safeExecute(page, () => this.findAndOpenForm(page));
      await this.safeExecute(page, () => this.fillFormWithData(page, leadData));

      this.logger.info('Waiting 5 seconds before closing...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      this.logger.error(`Error in Puppeteer task: ${error.message}`, error);
    } finally {
      if (page && !page.isClosed()) {
        await this.puppeteerService.releasePage(page);
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

  private async simulateScrolling(page: Page): Promise<void> {
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

        const pauseTime = Math.floor(Math.random() * 300) + 200;
        await new Promise((resolve) => setTimeout(resolve, pauseTime));
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      if (!page.isClosed()) {
        await page.evaluate(() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
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

  private async simulateRandomClicks(page: Page): Promise<void> {
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
            setTimeout(resolve, 2000 + Math.random() * 3000),
          );

          if (element.href && !element.href.startsWith('#')) {
            this.logger.info('Waiting for page navigation...');
            await page
              .waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
              .catch(() => {
                this.logger.warn('Page navigation timeout');
              });

            await new Promise((resolve) =>
              setTimeout(resolve, 3000 + Math.random() * 5000),
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
      await new Promise((resolve) => setTimeout(resolve, 1000));

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
      await new Promise((resolve) => setTimeout(resolve, 1500));

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
          await new Promise((resolve) => setTimeout(resolve, 500));

          const success = await page.evaluate(
            (selector, value) => {
              const element = document.querySelector(
                selector,
              ) as HTMLInputElement;
              if (element) {
                element.focus();
                element.value = '';
                element.dispatchEvent(new Event('input', { bubbles: true }));

                let currentValue = '';
                const typeSpeed = 250 + Math.random() * 100;

                const typeNextChar = () => {
                  if (currentValue.length < value.length) {
                    currentValue += value[currentValue.length];
                    element.value = currentValue;

                    setTimeout(typeNextChar, typeSpeed);
                  }
                };

                setTimeout(typeNextChar, 100);
                return true;
              }
              return false;
            },
            field.selector,
            value,
            field.type,
          );

          if (success) {
            this.logger.info(
              `✅ Filled field ${field.selector} (${field.type}) with value: ${value} (confidence: ${field.confidence})`,
            );

            const pauseTime = 300 + Math.random() * 700;
            await new Promise((resolve) => setTimeout(resolve, pauseTime));
          } else {
            this.logger.warn(`❌ Failed to find field ${field.selector}`);
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fill field ${field.selector}: ${error.message}`,
          );
        }
      }

      this.logger.info('All fields filled, preparing to submit form...');
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000),
      );

      const submitResult = await page.evaluate((formIndex) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms[formIndex];
        if (!form) return 'form_not_found';

        const submitButton = form.querySelector(
          'button[type="submit"], input[type="submit"]',
        ) as HTMLButtonElement | HTMLInputElement;

        if (submitButton && submitButton.offsetParent !== null) {
          setTimeout(() => {
            submitButton.click();
          }, 1000);

          return 'clicked_submit_button';
        } else {
          form.submit();
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
