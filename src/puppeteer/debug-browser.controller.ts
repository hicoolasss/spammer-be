import { CountryCode } from '@enums';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { LogWrapper } from '@utils';

import { PuppeteerService } from './puppeteer.service';

interface OpenBrowserDto {
  url: string;
  geo: string;
  ua: string;
}

@Controller('debug')
export class DebugBrowserController {
  private readonly logger = new LogWrapper(DebugBrowserController.name);

  constructor(private readonly puppeteerService: PuppeteerService) {}

  @Post('open')
  @HttpCode(HttpStatus.OK)
  async openBrowser(@Body() dto: OpenBrowserDto) {
    const { url, geo, ua } = dto;
    const geoCode = (geo?.toUpperCase() || 'CZ') as CountryCode;
    const taskId = `debug-${Date.now()}`;

    this.logger.info(`[${taskId}] Opening browser: ${url}`);
    this.logger.info(`[${taskId}] Geo: ${geoCode}, UA: ${ua.substring(0, 60)}...`);

    let browser;
    try {
      const result = await this.puppeteerService.createIsolatedPage(
        taskId,
        geoCode,
        ua,
        { isCaptcha: false },
      );
      browser = result.browser;
      const page = result.page;

      this.logger.info(`[${taskId}] Navigating to: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      this.logger.info(`[${taskId}] Page loaded, waiting 60s for redirects...`);

      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          this.logger.info(`[${taskId}] Navigated to: ${frame.url()}`);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 60000));

      const finalUrl = page.url();
      const title = await page.title().catch(() => 'N/A');

      this.logger.info(`[${taskId}] Done. Final URL: ${finalUrl}`);
      this.logger.info(`[${taskId}] Title: ${title}`);

      return {
        success: true,
        taskId,
        finalUrl,
        title,
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${taskId}] Error: ${errMsg}`);
      return {
        success: false,
        taskId,
        error: errMsg,
      };
    } finally {
      if (browser) {
        this.logger.info(`[${taskId}] Closing browser`);
        await browser.close().catch(() => {});
      }
    }
  }
}
