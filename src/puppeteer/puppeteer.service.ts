import { CountryCode } from '@enums';
import { Injectable, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { BrowserWrapper } from '@types';
import { IS_PROD_ENV, LogWrapper } from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import { getBrowserSpoofScript, getRandomItem, HEADERS, MOBILE_VIEWPORTS } from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';
import { browserOpenTimes, logAllGeoPoolsTable, pageOpenTimes } from 'src/utils/puppeteer-logging';

@Injectable()
export class PuppeteerService implements OnModuleDestroy {
  private readonly logger = new LogWrapper(PuppeteerService.name);
  private browserPool = new Map<CountryCode, BrowserWrapper[]>();
  private browserCreationLocks = new Map<CountryCode, Promise<void>>();

  private readonly MAX_BROWSERS_PER_GEO: number;
  private readonly MAX_TABS_PER_BROWSER: number;

  constructor() {
    this.MAX_BROWSERS_PER_GEO = Number(process.env.MAX_BROWSERS_PER_GEO) || 3;
    this.MAX_TABS_PER_BROWSER = Number(process.env.MAX_TABS_PER_BROWSER) || 20;

    this.logger.info(
      `[PuppeteerService] Environment variables: MAX_BROWSERS_PER_GEO=${process.env.MAX_BROWSERS_PER_GEO}, MAX_TABS_PER_BROWSER=${process.env.MAX_TABS_PER_BROWSER}`,
    );
    this.logger.info(
      `[PuppeteerService] Initialized with MAX_BROWSERS_PER_GEO=${this.MAX_BROWSERS_PER_GEO}, MAX_TABS_PER_BROWSER=${this.MAX_TABS_PER_BROWSER}`,
    );

    const disableGpuWarnings = process.env.DISABLE_GPU_WARNINGS === 'true';
    this.logger.info(`[PuppeteerService] GPU warnings disabled: ${disableGpuWarnings}`);

    setInterval(
      async () => {
        try {
          await this.cleanupPoolIssues();
        } catch (error) {
          this.logger.error(`[PuppeteerService] Error during periodic cleanup: ${error.message}`);
        }
      },
      5 * 60 * 1000,
    );
  }

  private sanitizeModuleScript(script: string): string {
    return script.replace(/^\s*(export|import)\s.*$/gm, '');
  }

  private handleChromePropertyError(err: Error, context: string): boolean {
    if (err.message.includes('Cannot redefine property: chrome')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('Cannot redefine property')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('Unexpected token')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('SyntaxError')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('Unexpected identifier')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('Unexpected end of input')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('Invalid or unexpected token')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('Failed to fetch')) {
      return true; // Error handled, should be ignored
    }
    if (err.message.includes('TypeError') && err.message.includes('fetch')) {
      return true; // Error handled, should be ignored
    }
    if (
      err.message.includes('vkCreateInstance') ||
      err.message.includes('VK_ERROR_INCOMPATIBLE_DRIVER') ||
      err.message.includes('eglChooseConfig') ||
      err.message.includes('BackendType::OpenGLES')
    ) {
      return true; // Error handled, should be ignored
    }
    this.logger.error(`${context} error: ${err}`);
    return false; // Error not handled, should be logged
  }

  async onModuleInit() {
    if (!process.env.PROXY_HOST) {
      this.logger.error('Proxy host is not set in environment variables');
    }

    if (!process.env.PROXY_HOST) {
      this.logger.error('Proxy host is not set in environment variables');
    }

    if (!process.env.PROXY_USERNAME) {
      this.logger.error('Proxy username is not set in environment variables');
    }

    if (!process.env.PROXY_PASSWORD) {
      this.logger.error('Proxy password is not set in environment variables');
    }
  }

  async onModuleDestroy() {
    for (const pool of this.browserPool.values()) {
      for (const wrapper of pool) {
        for (const p of wrapper.pages) {
          try {
            await p.close();
          } catch {
            // Ignore
          }
        }
        try {
          await wrapper.context.close();
        } catch {
          // Ignore
        }
        try {
          await wrapper.browser.close();
        } catch {
          // Ignore
        }
      }
    }
    this.browserPool.clear();
  }

  async acquirePage(proxyGeo: CountryCode, userAgent: string): Promise<Page> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
    const pool = this.browserPool.get(proxyGeo) || [];

    this.logger.debug(
      `[acquirePage] geo=${proxyGeo} | pool.length=${pool.length}, MAX_BROWSERS=${this.MAX_BROWSERS_PER_GEO}, MAX_TABS=${this.MAX_TABS_PER_BROWSER}`,
    );

    for (const wrapper of pool) {
      wrapper.pages = wrapper.pages.filter((page) => !page.isClosed());
    }

    const getBrowserWithFreeSlot = () =>
      pool.find((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);
    let wrapper = getBrowserWithFreeSlot();

    if (wrapper) {
      this.logger.debug(
        `[acquirePage] geo=${proxyGeo} | Найден браузер с ${wrapper.pages.length} вкладками, добавляю вкладку`,
      );
      const page = await this._openPage(wrapper, userAgent, locale, timeZone, proxyGeo);
      logAllGeoPoolsTable(this.browserPool);
      return page;
    }

    if (pool.length < this.MAX_BROWSERS_PER_GEO) {
      this.logger.debug(
        `[acquirePage] geo=${proxyGeo} | Создаю новый браузер, pool.length=${pool.length} < ${this.MAX_BROWSERS_PER_GEO}`,
      );
      if (!this.browserCreationLocks.has(proxyGeo)) {
        const lockPromise = new Promise<void>((resolve) => {
          resolve();
        });
        this.browserCreationLocks.set(proxyGeo, lockPromise);
        let newWrapper: BrowserWrapper;
        try {
          newWrapper = await this.getOrCreateBrowserForGeo(proxyGeo, locale, timeZone);
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | Новый браузер создан, добавляю вкладку`,
          );
          newWrapper.pages.push(
            await this._openPage(newWrapper, userAgent, locale, timeZone, proxyGeo),
          );
          logAllGeoPoolsTable(this.browserPool);
          return newWrapper.pages[0];
        } catch (err) {
          if (newWrapper) newWrapper.pages = [];
          throw err;
        } finally {
          this.browserCreationLocks.delete(proxyGeo);
        }
      } else {
        this.logger.debug(`[acquirePage] geo=${proxyGeo} | Жду создания браузера другим потоком`);
        await this.browserCreationLocks.get(proxyGeo);
        const updatedPool = this.browserPool.get(proxyGeo) || [];
        wrapper = updatedPool.find((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);
        if (wrapper) {
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | После ожидания найден браузер с ${wrapper.pages.length} вкладками`,
          );
          const page = await this._openPage(wrapper, userAgent, locale, timeZone, proxyGeo);
          logAllGeoPoolsTable(this.browserPool);
          return page;
        }
      }
    } else {
      this.logger.debug(
        `[acquirePage] geo=${proxyGeo} | Достигнут лимит браузеров: ${pool.length} >= ${this.MAX_BROWSERS_PER_GEO}`,
      );
    }

    wrapper = pool.reduce((min, w) => (w.pages.length < min.pages.length ? w : min), pool[0]);
    this.logger.debug(
      `[acquirePage] geo=${proxyGeo} | Использую браузер с наименьшим количеством вкладок: ${wrapper.pages.length}`,
    );

    const page = await this._openPage(wrapper, userAgent, locale, timeZone, proxyGeo);
    logAllGeoPoolsTable(this.browserPool);
    return page;
  }

  private async _openPage(
    wrapper: BrowserWrapper,
    userAgent: string,
    locale: string,
    timeZone: string,
    proxyGeo: CountryCode,
  ): Promise<Page> {
    this.logger.debug(
      `[_openPage] geo=${proxyGeo} | Текущие вкладки: ${wrapper.pages.length}, лимит: ${this.MAX_TABS_PER_BROWSER}`,
    );

    if (wrapper.pages.length >= this.MAX_TABS_PER_BROWSER) {
      this.logger.error(
        `[_openPage] geo=${proxyGeo} | Попытка открыть вкладку при переполнении: уже ${wrapper.pages.length} вкладок (лимит ${this.MAX_TABS_PER_BROWSER})`,
      );
      throw new Error('MAX_TABS limit reached for this browser');
    }

    const page = await wrapper.context.newPage();
    const pageOpenTime = Date.now();

    pageOpenTimes.set(page, pageOpenTime);
    const storedTime = pageOpenTimes.get(page);

    if (!storedTime) {
      this.logger.error(`[_openPage] geo=${proxyGeo} | FAILED to store page time!`);
    }

    this.logger.debug(
      `[_openPage] geo=${proxyGeo} | Вкладка создана, время: ${pageOpenTime}, сохранено: ${storedTime}, всего вкладок: ${wrapper.pages.length}`,
    );

    wrapper.pages.push(page);

    page.on('close', () => {
      this.logger.debug(`[_openPage] geo=${proxyGeo} | Вкладка закрыта, удаляю из времени`);
      pageOpenTimes.delete(page);
    });

    this.logger.debug(
      `[_openPage] geo=${proxyGeo} | Вкладка создана, время: ${pageOpenTime}, всего вкладок: ${wrapper.pages.length}`,
    );

    try {
      await page.authenticate({
        username: process.env.PROXY_USERNAME,
        password: `${process.env.PROXY_PASSWORD}_country-${proxyGeo}`,
      });
    } catch (e) {
      this.logger.error(`Error in page.authenticate: ${e.message}`);
    }

    try {
      await page.setUserAgent(userAgent);
      const headers = HEADERS(locale, userAgent);
      await page.setExtraHTTPHeaders(headers);
      await page.emulateTimezone(timeZone);

      const localeRaw = getBrowserSpoofScript(locale, timeZone);
      const localeScript = this.sanitizeModuleScript(localeRaw);

      await page.evaluateOnNewDocument(`(()=>{${localeScript}})();`);

      const baseViewport = getRandomItem(MOBILE_VIEWPORTS);
      const isLandscape = baseViewport.screenSize > 7 && Math.random() < 0.5;

      await page.emulate({
        viewport: {
          width: isLandscape ? baseViewport.height : baseViewport.width,
          height: isLandscape ? baseViewport.width : baseViewport.height,
          deviceScaleFactor: baseViewport.deviceScaleFactor,
          isMobile: true,
          hasTouch: true,
        },
        userAgent,
      });
      await page.setRequestInterception(true);

      page.on('request', async (req) => {
        return req.continue();
      });

      page.on('error', (err) => {
        if (err.message.includes('net::ERR_TUNNEL_CONNECTION_FAILED')) {
          this.logger.warn(`[PuppeteerService] Network error [${proxyGeo}]: ${err.message}`);
          return;
        }
        if (err.message.includes('net::ERR_')) {
          this.logger.warn(`[PuppeteerService] Network error [${proxyGeo}]: ${err.message}`);
          return;
        }
        if (err.message.includes('Failed to fetch')) {
          this.logger.warn(`[PuppeteerService] Fetch error [${proxyGeo}]: ${err.message}`);
          return;
        }
        if (err.message.includes('TypeError') && err.message.includes('fetch')) {
          this.logger.warn(`[PuppeteerService] Fetch error [${proxyGeo}]: ${err.message}`);
          return;
        }
        if (this.handleChromePropertyError(err, `Page error [${proxyGeo}]`)) return;
      });

      page.on('pageerror', (err) => {
        if (err.message.includes('setCookie is not defined')) {
          return;
        }
        if (
          err.message.includes('Identifier') &&
          err.message.includes('has already been declared')
        ) {
          return;
        }
        if (err.message.includes('e.indexOf is not a function')) {
          return;
        }
        if (err.message.includes('SyntaxError')) {
          return;
        }
        if (err.message.includes('Unexpected token')) {
          return; // Ignore syntax errors with unexpected tokens
        }
        if (err.message.includes('Unexpected identifier')) {
          return; // Ignore syntax errors with unexpected identifiers
        }
        if (err.message.includes('Unexpected end of input')) {
          return; // Ignore syntax errors with unexpected end of input
        }
        if (err.message.includes('Invalid or unexpected token')) {
          return; // Ignore syntax errors with invalid tokens
        }
        if (err.message.includes('Failed to fetch')) {
          return; // Ignore network fetch errors
        }
        if (err.message.includes('TypeError') && err.message.includes('fetch')) {
          return; // Ignore fetch-related type errors
        }
        if (this.handleChromePropertyError(err, `Runtime error [${proxyGeo}]`)) return;
        this.logger.error(`Runtime error [${proxyGeo}]: ${err}`);
      });
    } catch (error) {
      this.logger.error(`[_openPage] geo=${proxyGeo} | Error setting up page: ${error.message}`);
    }

    const finalTime = pageOpenTimes.get(page);
    if (!finalTime) {
      this.logger.error(`[_openPage] geo=${proxyGeo} | Page time was lost during setup!`);
      pageOpenTimes.set(page, pageOpenTime);
    }

    return page;
  }

  async releasePage(page: Page, geo: CountryCode): Promise<void> {
    const pool = this.browserPool.get(geo) || [];

    for (const wrapper of pool) {
      const idx = wrapper.pages.indexOf(page);

      if (idx === -1) continue;

      const pageOpenTime = pageOpenTimes.get(page);
      const pageAge = pageOpenTime ? Date.now() - pageOpenTime : 'unknown';
      this.logger.debug(
        `[releasePage] geo=${geo} | Закрываю вкладку, время жизни: ${pageAge}ms, всего вкладок в браузере: ${wrapper.pages.length}`,
      );

      if (!pageOpenTime) {
        this.logger.warn(`[releasePage] geo=${geo} | ВНИМАНИЕ: Вкладка не имеет записи времени!`);
        this.logger.debug(
          `[releasePage] geo=${geo} | Page URL: ${page.url()}, isClosed: ${page.isClosed()}`,
        );
      }

      wrapper.pages.splice(idx, 1);
      pageOpenTimes.delete(page);

      await page.setRequestInterception(false).catch(() => {});
      page.removeAllListeners('request');
      await page.close().catch(() => {});

      this.logger.debug(
        `[releasePage] geo=${geo} | Вкладка закрыта, осталось вкладок: ${wrapper.pages.length}`,
      );

      if (wrapper.pages.length === 0) {
        this.logger.debug(`[releasePage] geo=${geo} | Браузер пуст, закрываю его`);
        await wrapper.context.close().catch(() => {});
        await wrapper.browser.close().catch(() => {});
        pool.splice(pool.indexOf(wrapper), 1);

        if (pool.length === 0) {
          this.browserPool.delete(geo);
        }
      }

      logAllGeoPoolsTable(this.browserPool);

      return;
    }
  }

  async diagnosePoolIssues(): Promise<void> {
    this.logger.info('🔍 Starting pool diagnosis...');

    for (const [geo, pool] of this.browserPool.entries()) {
      this.logger.info(`\n[DIAGNOSIS] Geo: ${geo}`);
      this.logger.info(`[DIAGNOSIS] Total browsers: ${pool.length}`);

      let totalTabs = 0;
      let closedTabs = 0;
      let orphanedTabs = 0;

      for (const [browserIndex, wrapper] of pool.entries()) {
        const browserTime = browserOpenTimes.get(wrapper.browser);
        const browserAge = browserTime ? Date.now() - browserTime : 'unknown';

        this.logger.info(`[DIAGNOSIS] Browser #${browserIndex + 1}:`);
        this.logger.info(`  - Connected: ${wrapper.browser.isConnected()}`);
        this.logger.info(`  - Age: ${browserAge}ms`);
        this.logger.info(`  - Tabs: ${wrapper.pages.length}/${this.MAX_TABS_PER_BROWSER}`);

        totalTabs += wrapper.pages.length;

        for (const [tabIndex, page] of wrapper.pages.entries()) {
          const pageTime = pageOpenTimes.get(page);
          const pageAge = pageTime ? Date.now() - pageTime : 'unknown';
          const isClosed = page.isClosed();

          if (isClosed) closedTabs++;
          if (!pageTime) orphanedTabs++;

          this.logger.info(
            `  - Tab #${tabIndex + 1}: ${isClosed ? 'CLOSED' : 'OPEN'}, Age: ${pageAge}ms, URL: ${page.url()}`,
          );
        }
      }

      this.logger.info(`[DIAGNOSIS] Summary for ${geo}:`);
      this.logger.info(`  - Total tabs: ${totalTabs}`);
      this.logger.info(`  - Closed tabs: ${closedTabs}`);
      this.logger.info(`  - Orphaned tabs: ${orphanedTabs}`);
      this.logger.info(
        `  - Utilization: ${totalTabs}/${pool.length * this.MAX_TABS_PER_BROWSER} (${Math.round((totalTabs / (pool.length * this.MAX_TABS_PER_BROWSER)) * 100)}%)`,
      );
    }
  }

  async cleanupPoolIssues(): Promise<void> {
    this.logger.info('🧹 Starting pool cleanup...');

    for (const [geo, pool] of this.browserPool.entries()) {
      this.logger.info(`[CLEANUP] Cleaning geo: ${geo}`);

      for (const wrapper of pool) {
        const originalLength = wrapper.pages.length;
        wrapper.pages = wrapper.pages.filter((page) => !page.isClosed());
        const removedCount = originalLength - wrapper.pages.length;

        if (removedCount > 0) {
          this.logger.info(`[CLEANUP] Removed ${removedCount} closed tabs from browser`);
        }
      }

      const originalPoolLength = pool.length;
      const nonEmptyBrowsers = pool.filter((wrapper) => wrapper.pages.length > 0);

      if (nonEmptyBrowsers.length < pool.length) {
        this.logger.info(
          `[CLEANUP] Removing ${pool.length - nonEmptyBrowsers.length} empty browsers`,
        );

        for (const wrapper of pool) {
          if (wrapper.pages.length === 0) {
            try {
              await wrapper.context.close();
              await wrapper.browser.close();
            } catch (error) {
              this.logger.warn(`[CLEANUP] Error closing empty browser: ${error.message}`);
            }
          }
        }

        this.browserPool.set(geo, nonEmptyBrowsers);
      }

      this.logger.info(
        `[CLEANUP] Geo ${geo}: ${originalPoolLength} -> ${nonEmptyBrowsers.length} browsers`,
      );
    }

    this.logger.info('🧹 Pool cleanup completed');
  }

  private async createBrowser(locale: string, timeZone: string): Promise<Browser> {
    dns.setServers(['1.1.1.1']);
    let browser: Browser;
    try {
      browser = await launch({
        headless: IS_PROD_ENV,
        dumpio: true,
        pipe: true,
        args: [
          `--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`,
          `--lang=${locale}`,
          `--timezone=${timeZone}`,
          '--disable-web-security',
          '--allow-running-insecure-content',
          '--ignore-certificate-errors',
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-gpu-sandbox',
          '--disable-software-rasterizer',
          '--disable-gl-drawing-for-tests',
          '--disable-egl',
          '--disable-angle',
          '--disable-webgl',
          '--disable-webgl2',
          '--disable-vulkan',
          '--disable-vulkan-fallback',
          '--disable-gpu-compositing',
          '--disable-gpu-rasterization',
          '--disable-gpu-memory-buffer-video-frames',
          '--disable-gpu-memory-buffer-compositor-resources',
          '--disable-gpu-memory-buffer-video-capture',
          '--disable-gpu-memory-buffer-2d-canvas',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--use-gl=swiftshader',
          '--use-angle=swiftshader',
        ],
        slowMo: 0,
        defaultViewport: null,
      });
    } catch (e) {
      throw new InternalServerErrorException(`Failed to launch browser: ${e.message}`);
    }
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
    } catch {
      // Ignore
    }
    browserOpenTimes.set(browser, Date.now());
    browser.on('disconnected', () => {
      this.logger.warn(`[createBrowser] Browser disconnected, clearing all pools`);
      this.browserPool.clear();
    });

    browser.on('error', (err: Error) => {
      if (
        err.message.includes('vkCreateInstance') ||
        err.message.includes('VK_ERROR_INCOMPATIBLE_DRIVER') ||
        err.message.includes('eglChooseConfig') ||
        err.message.includes('BackendType::OpenGLES') ||
        err.message.includes("Couldn't get proc eglChooseConfig") ||
        err.message.includes('Failed to fetch') ||
        err.message.includes('TypeError') ||
        err.message.includes('net::ERR_')
      ) {
        this.logger.debug(`[createBrowser] Graphics/Network warning: ${err.message}`);
        return;
      }
      if (this.handleChromePropertyError(err, 'Browser error')) return;
    });

    return browser;
  }

  private async getOrCreateBrowserForGeo(
    countryCode: CountryCode,
    locale: string,
    timeZone: string,
  ): Promise<BrowserWrapper> {
    const pool = this.browserPool.get(countryCode) || [];
    this.logger.debug(
      `[getOrCreateBrowserForGeo] geo=${countryCode} | pool.length=${pool.length}, MAX_BROWSERS=${this.MAX_BROWSERS_PER_GEO}, MAX_TABS=${this.MAX_TABS_PER_BROWSER}`,
    );

    if (pool.length < this.MAX_BROWSERS_PER_GEO) {
      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | Создаю новый браузер, pool.length=${pool.length}, MAX_BROWSERS=${this.MAX_BROWSERS_PER_GEO}`,
      );

      const browser = await this.createBrowser(locale, timeZone);
      const context = await browser.createBrowserContext();

      context.on('error', (err: Error) => {
        if (this.handleChromePropertyError(err, 'Context error')) return;
      });

      const wrapper = { browser, context, pages: [] };
      pool.push(wrapper);
      this.browserPool.set(countryCode, pool);

      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | Новый браузер создан, pool.length=${pool.length}`,
      );
      return wrapper;
    }

    let wrapper = pool.find((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);
    if (wrapper) {
      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | Найден существующий браузер с ${wrapper.pages.length} вкладками`,
      );
      return wrapper;
    }

    this.logger.debug(
      `[getOrCreateBrowserForGeo] geo=${countryCode} | Не могу создать браузер, pool.length=${pool.length} >= ${this.MAX_BROWSERS_PER_GEO}`,
    );
    wrapper = pool.reduce((min, w) => (w.pages.length < min.pages.length ? w : min), pool[0]);
    return wrapper;
  }
}
