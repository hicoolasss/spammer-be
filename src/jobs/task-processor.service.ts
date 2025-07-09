import { CountryCode } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { LogWrapper } from '@utils';
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
      const taskId = '6867fe3e6765e9896589ea5f';

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

      this.logger.info(
        `Found profile: ${profile.name}, leadKey: ${profile.leadKey}`,
      );

      const leadData = await this.redisService.getLeadData(profile.leadKey);
      if (!leadData) {
        this.logger.error(`No lead data found for key: ${profile.leadKey}`);
        return;
      }

      this.logger.info(`Retrieved lead data: ${JSON.stringify(leadData)}`);

      await this.runPuppeteerTask(task.url, task.geo, leadData);
    } catch (error) {
      this.logger.error(`Error processing task: ${error.message}`, error);
    }
  }

  private async runPuppeteerTask(
    url: string,
    geo: string,
    leadData: LeadData,
  ): Promise<void> {
    let page: Page | null = null;

    try {
      const { page: puppeteerPage } = await this.puppeteerService.acquirePage(
        'task-processor',
        geo as CountryCode,
      );
      page = puppeteerPage;

      this.logger.info(`Navigating to: ${url}`);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      await this.simulateScrolling(page);
      await this.simulateRandomClicks(page);
      await this.findAndOpenForm(page);
      await this.fillFormWithData(page, leadData);

      this.logger.info('Waiting 5 seconds before closing...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      this.logger.error(`Error in Puppeteer task: ${error.message}`, error);
    } finally {
      if (page) {
        await this.puppeteerService.releasePage(page);
      }
    }
  }

  private async simulateScrolling(page: Page): Promise<void> {
    this.logger.info('Simulating scrolling...');

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, Math.random() * 500 + 300);
      });
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000),
      );
    }

    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async simulateRandomClicks(page: Page): Promise<void> {
    this.logger.info('Simulating random clicks...');

    for (let i = 0; i < 2; i++) {
      const x = Math.random() * 800 + 100;
      const y = Math.random() * 600 + 100;

      await page.mouse.click(x, y);
      await new Promise((resolve) =>
        setTimeout(resolve, 500 + Math.random() * 1000),
      );
    }
  }

  private async findAndOpenForm(page: Page): Promise<void> {
    this.logger.info('Looking for form...');

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

      for (const selector of formSelectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          this.logger.info(`Found form elements with selector: ${selector}`);

          await elements[0].click();
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return;
        }
      }

      this.logger.warn('No form found on the page');
    } catch (error) {
      this.logger.error(`Error finding form: ${error.message}`);
    }
  }

  private async fillFormWithData(
    page: Page,
    leadData: LeadData,
  ): Promise<void> {
    this.logger.info('Filling form with lead data...');

    try {
      const fieldMappings = [
        {
          dataKey: 'name',
          selectors: [
            'input[name*="name" i]',
            'input[placeholder*="name" i]',
            '#name',
            '.name',
          ],
        },
        {
          dataKey: 'lastname',
          selectors: [
            'input[name*="lastname" i]',
            'input[name*="surname" i]',
            'input[placeholder*="lastname" i]',
            '#lastname',
            '.lastname',
          ],
        },
        {
          dataKey: 'email',
          selectors: [
            'input[type="email"]',
            'input[name*="email" i]',
            'input[placeholder*="email" i]',
            '#email',
            '.email',
          ],
        },
        {
          dataKey: 'phone',
          selectors: [
            'input[type="tel"]',
            'input[name*="phone" i]',
            'input[name*="tel" i]',
            'input[placeholder*="phone" i]',
            '#phone',
            '.phone',
          ],
        },
      ];

      for (const mapping of fieldMappings) {
        const value = leadData[mapping.dataKey];
        if (!value) continue;

        for (const selector of mapping.selectors) {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            this.logger.info(`Filling ${mapping.dataKey} with value: ${value}`);

            await elements[0].click();
            await elements[0].type(value, { delay: 100 });
            await new Promise((resolve) => setTimeout(resolve, 500));
            break;
          }
        }
      }

      this.logger.info('Form filling completed');
    } catch (error) {
      this.logger.error(`Error filling form: ${error.message}`);
    }
  }
}
