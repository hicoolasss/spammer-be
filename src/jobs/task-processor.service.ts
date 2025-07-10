import { CountryCode } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { getRandomItem, LogWrapper } from '@utils';
import { Model } from 'mongoose';
import { Page } from 'puppeteer';

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
  ) {}

  async processRandomTask(): Promise<void> {
    try {
      const mockTaskId = '686804a08e868743ae0316ad'; // TODO
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
      const userAgents = await this.redisService.getUserAgentsData(userAgentKey);
      const fbclid = await this.redisService.getFbclidData(fbclidKey);

      const url = task.url + '&fbclid=' + fbclid;
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
    this.logger.info('Simulating scrolling...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping scrolling');
      return;
    }

    try {
      for (let i = 0; i < 3; i++) {
        if (page.isClosed()) break;

        await page.evaluate(() => {
          window.scrollBy(0, Math.random() * 500 + 300);
        });
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 + Math.random() * 1000),
        );
      }

      if (!page.isClosed()) {
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (error.message.includes('Execution context was destroyed')) {
        this.logger.warn('Page context destroyed during scrolling');
        return;
      }
      throw error;
    }
  }

  private async simulateRandomClicks(page: Page): Promise<void> {
    this.logger.info('Simulating random clicks...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping random clicks');
      return;
    }

    try {
      for (let i = 0; i < 2; i++) {
        if (page.isClosed()) break;

        const x = Math.random() * 800 + 100;
        const y = Math.random() * 600 + 100;

        await page.mouse.click(x, y);
        await new Promise((resolve) =>
          setTimeout(resolve, 500 + Math.random() * 1000),
        );
      }
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
    this.logger.info('Looking for form...');

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping form search');
      return;
    }

    try {
      const formSelectors = [
        'form',
        '[data-form]',
        '.form',
        '#form',
        '[class*="form"]',
        '[id*="form"]',
        'button[type="submit"]',
        'input[type="submit"]',
        '[class*="submit"]',
        '[class*="apply"]',
        '[class*="contact"]',
      ];

      for (let attempt = 0; attempt < 10; attempt++) {
        if (page.isClosed()) break;

        for (const selector of formSelectors) {
          if (page.isClosed()) break;

          try {
            await page.waitForSelector(selector, { timeout: 1000 });
            const elements = await page.$$(selector);

            if (elements.length > 0) {
              if (elements.length > 1) {
                this.logger.warn(
                  `Found ${elements.length} form elements with selector: ${selector}. This might indicate multiple forms on the page.`,
                );
              } else {
                this.logger.info(
                  `Found form element with selector: ${selector}`,
                );
              }

              const isVisible = await elements[0].evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0'
                );
              });

              if (isVisible) {
                await elements[0].scrollIntoView();
                await new Promise((resolve) => setTimeout(resolve, 500));

                await elements[0].click({ delay: 100 });
                this.logger.info('Successfully clicked on form element');
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return;
              } else {
                this.logger.debug(`Element ${selector} found but not visible`);
              }
            }
          } catch {
            continue;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.logger.debug(`Form search attempt ${attempt + 1}/10`);
      }

      this.logger.warn('No clickable form found on the page after 10 attempts');
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
    this.logger.info('Filling form with lead data...');
    this.logger.info(`Available lead data: ${JSON.stringify(leadData)}`);

    if (page.isClosed()) {
      this.logger.warn('Page is closed, skipping form filling');
      return;
    }

    try {
      const formInfo = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        const result = forms.map((form, idx) => {
          const inputs = Array.from(
            form.querySelectorAll('input'),
          ) as HTMLInputElement[];
          const visibleInputs = inputs.filter(
            (el) =>
              (el.type === 'text' || el.type === 'email') &&
              el.offsetParent !== null &&
              window.getComputedStyle(el).display !== 'none' &&
              window.getComputedStyle(el).visibility !== 'hidden',
          );
          return {
            idx,
            inputCount: inputs.length,
            visibleTextOrEmailCount: visibleInputs.length,
            fields: visibleInputs.map((el) => ({
              type: el.type,
              name: el.name || '',
              id: el.id || '',
              placeholder: el.placeholder || '',
            })),
          };
        });
        return result;
      });

      const formsWithFields = formInfo.filter(
        (f) => f.visibleTextOrEmailCount > 0,
      );
      if (formInfo.length > 1) {
        this.logger.warn(
          `Found ${formInfo.length} forms on page. Forms with visible text/email fields: ${formsWithFields.length}`,
        );
      }
      if (formsWithFields.length === 0) {
        this.logger.warn(
          'No suitable form with visible text/email fields found',
        );
        return;
      }
      const targetFormIdx = formsWithFields[0].idx;
      const inputFields = formsWithFields[0].fields;
      this.logger.info(
        `Using form #${targetFormIdx} with fields: ${JSON.stringify(inputFields)}`,
      );

      for (let i = 0; i < inputFields.length; i++) {
        const field = inputFields[i];
        let value = '';
        if (field.type === 'email') {
          value = leadData.email || '';
        } else if (
          /last/i.test(field.name) ||
          /last/i.test(field.id) ||
          /last/i.test(field.placeholder)
        ) {
          value = leadData.lastname || '';
        } else if (
          /phone|tel/i.test(field.name) ||
          /phone|tel/i.test(field.id) ||
          /phone|tel/i.test(field.placeholder)
        ) {
          value = leadData.phone || '';
        } else if (
          /name/i.test(field.name) ||
          /name/i.test(field.id) ||
          /name/i.test(field.placeholder)
        ) {
          value = leadData.name || '';
        }

        if (!value) {
          this.logger.warn(
            `No value found for field: ${JSON.stringify(field)}, skipping`,
          );
          continue;
        }

        await page.evaluate(
          (formIdx, field, value) => {
            const forms = Array.from(document.querySelectorAll('form'));
            const form = forms[formIdx];
            if (!form) return;
            const candidates = Array.from(
              form.querySelectorAll('input'),
            ) as HTMLInputElement[];
            const el = candidates.find(
              (el) =>
                el.type === field.type &&
                el.name === field.name &&
                el.id === field.id &&
                el.placeholder === field.placeholder,
            );
            if (el) {
              el.focus();
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          },
          targetFormIdx,
          field,
          value,
        );
        this.logger.info(
          `Filled field: ${JSON.stringify(field)} with value: ${value}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      const submitResult = await page.evaluate(async (formIdx) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const form = forms[formIdx];
        if (!form) return 'form_not_found';
        const btn = Array.from(
          form.querySelectorAll('button[type="submit"],input[type="submit"]'),
        ).find((el) => {
          const htmlEl = el as HTMLElement;
          return (
            htmlEl.offsetParent !== null &&
            window.getComputedStyle(htmlEl).display !== 'none' &&
            window.getComputedStyle(htmlEl).visibility !== 'hidden'
          );
        });
        if (btn) {
          (btn as HTMLButtonElement | HTMLInputElement).click();
          return 'clicked_submit_button';
        } else {
          form.submit();
          return 'called_form_submit';
        }
      }, targetFormIdx);
      this.logger.info(`Form submit result: ${submitResult}`);

      this.logger.info('Form filling completed');
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        this.logger.warn('Page context destroyed during form filling');
        return;
      }
      this.logger.error(`Error filling form: ${error.message}`);
    }
  }
}
