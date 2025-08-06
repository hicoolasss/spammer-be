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
    this.MAX_BROWSERS_PER_GEO = Number(process.env.MAX_BROWSERS_PER_GEO) || 10;
    this.MAX_TABS_PER_BROWSER = Number(process.env.MAX_TABS_PER_BROWSER) || 10;

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

    const logRuntimeErrors = process.env.LOG_RUNTIME_ERRORS === 'true';
    this.logger.info(`[PuppeteerService] Runtime errors logging: ${logRuntimeErrors}`);
  }

  private sanitizeModuleScript(script: string): string {
    return script.replace(/^\s*(export|import)\s.*$/gm, '');
  }

  private handleChromePropertyError(err: Error, context: string): boolean {
    if (err.message.includes('Cannot redefine property: chrome')) {
      return true;
    }
    if (err.message.includes('Cannot redefine property')) {
      return true;
    }
    if (err.message.includes('Unexpected token')) {
      return true;
    }
    if (err.message.includes('SyntaxError')) {
      return true;
    }
    if (err.message.includes('Unexpected identifier')) {
      return true;
    }
    if (err.message.includes('Unexpected end of input')) {
      return true;
    }
    if (err.message.includes('Invalid or unexpected token')) {
      return true;
    }
    if (err.message.includes('Failed to fetch')) {
      return true;
    }
    if (err.message.includes('TypeError') && err.message.includes('fetch')) {
      return true;
    }

    if (err.message.includes('Cannot read properties of undefined')) {
      return true;
    }
    if (err.message.includes('prototype')) {
      return true;
    }
    if (err.message.includes('masterstroke_ajax is not defined')) {
      return true;
    }
    if (err.message.includes('wp is not defined')) {
      return true;
    }
    if (err.message.includes('i18n')) {
      return true;
    }
    if (err.message.includes('hooks')) {
      return true;
    }
    if (err.message.includes('ReferenceError')) {
      return true;
    }
    if (err.message.includes('TypeError')) {
      return true;
    }

    // Системные ошибки браузера
    if (
      err.message.includes('vkCreateInstance') ||
      err.message.includes('VK_ERROR_INCOMPATIBLE_DRIVER') ||
      err.message.includes('eglChooseConfig') ||
      err.message.includes('BackendType::OpenGLES') ||
      err.message.includes('Bind context provider failed') ||
      err.message.includes('handshake failed') ||
      err.message.includes('SSL error code') ||
      err.message.includes('video_capture_service_impl')
    ) {
      return true;
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

    const totalTabs = pool.reduce((sum, w) => sum + w.pages.length, 0);
    const avgTabsPerBrowser = pool.length > 0 ? Math.round(totalTabs / pool.length) : 0;
    this.logger.info(
      `[acquirePage] geo=${proxyGeo} | Диагностика: браузеров=${pool.length}, всего вкладок=${totalTabs}, среднее=${avgTabsPerBrowser}/браузер`,
    );

    for (const wrapper of pool) {
      wrapper.pages = wrapper.pages.filter((page) => !page.isClosed());
    }

    let shouldCreateNewBrowser = false;

    if (pool.length === 0) {
      shouldCreateNewBrowser = true;
      this.logger.info(`[acquirePage] geo=${proxyGeo} | 🚀 Создаю первый браузер!`);
    } else if (pool.every((w) => w.pages.length >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.7))) {
      shouldCreateNewBrowser = true;
      this.logger.info(
        `[acquirePage] geo=${proxyGeo} | 🚀 Все браузеры заполнены на 70%+, создаю новый!`,
      );
    } else if (
      avgTabsPerBrowser >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.6) &&
      pool.length < this.MAX_BROWSERS_PER_GEO
    ) {
      shouldCreateNewBrowser = true;
      this.logger.info(
        `[acquirePage] geo=${proxyGeo} | 🚀 Среднее вкладок ${avgTabsPerBrowser} >= ${Math.floor(this.MAX_TABS_PER_BROWSER * 0.6)}, создаю новый браузер!`,
      );
    }

    if (shouldCreateNewBrowser && pool.length < this.MAX_BROWSERS_PER_GEO) {
      this.logger.info(
        `[acquirePage] geo=${proxyGeo} | 🚀 Создаю новый браузер! pool.length=${pool.length} < ${this.MAX_BROWSERS_PER_GEO}`,
      );

      if (!this.browserCreationLocks.has(proxyGeo)) {
        const lockPromise = new Promise<void>((resolve) => {
          resolve();
        });
        this.browserCreationLocks.set(proxyGeo, lockPromise);

        try {
          const newWrapper = await this.getOrCreateBrowserForGeo(proxyGeo, locale, timeZone);
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | Новый браузер создан, добавляю вкладку`,
          );
          const page = await this._openPage(newWrapper, userAgent, locale, timeZone, proxyGeo);
          logAllGeoPoolsTable(this.browserPool);
          return page;
        } catch (err) {
          this.logger.error(
            `[acquirePage] geo=${proxyGeo} | Ошибка создания браузера: ${err.message}`,
          );
          throw err;
        } finally {
          this.browserCreationLocks.delete(proxyGeo);
        }
      } else {
        this.logger.debug(`[acquirePage] geo=${proxyGeo} | Жду создания браузера другим потоком`);
        await this.browserCreationLocks.get(proxyGeo);
        const updatedPool = this.browserPool.get(proxyGeo) || [];
        const wrapper = updatedPool.find((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);
        if (wrapper) {
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | После ожидания найден браузер с ${wrapper.pages.length} вкладками`,
          );
          const page = await this._openPage(wrapper, userAgent, locale, timeZone, proxyGeo);
          logAllGeoPoolsTable(this.browserPool);
          return page;
        }
      }
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

    // Если все браузеры заполнены, но можем создать новый
    if (pool.length < this.MAX_BROWSERS_PER_GEO) {
      this.logger.info(
        `[acquirePage] geo=${proxyGeo} | Все браузеры заполнены, создаю дополнительный браузер`,
      );
      try {
        const newWrapper = await this.getOrCreateBrowserForGeo(proxyGeo, locale, timeZone);
        const page = await this._openPage(newWrapper, userAgent, locale, timeZone, proxyGeo);
        logAllGeoPoolsTable(this.browserPool);
        return page;
      } catch (err) {
        this.logger.error(
          `[acquirePage] geo=${proxyGeo} | Ошибка создания дополнительного браузера: ${err.message}`,
        );
      }
    }

    if (pool.length >= this.MAX_BROWSERS_PER_GEO) {
      this.logger.warn(
        `[acquirePage] geo=${proxyGeo} | Достигнут лимит браузеров: ${pool.length} >= ${this.MAX_BROWSERS_PER_GEO}`,
      );
    }

    wrapper = pool.reduce((min, w) => (w.pages.length < min.pages.length ? w : min), pool[0]);
    this.logger.debug(
      `[acquirePage] geo=${proxyGeo} | Использую браузер с наименьшим количеством вкладок: ${wrapper.pages.length}`,
    );

    const page = await this._openPage(wrapper, userAgent, locale, timeZone, proxyGeo);
    this.logger.info(
      `[acquirePage] geo=${proxyGeo} | ✅ Вкладка создана! Теперь браузеров=${pool.length}, всего вкладок=${pool.reduce((sum, w) => sum + w.pages.length, 0)}`,
    );

    const totalTabsAfter = pool.reduce((sum, w) => sum + w.pages.length, 0);
    const avgTabsPerBrowserAfter = pool.length > 0 ? Math.round(totalTabsAfter / pool.length) : 0;
    this.logger.info(
      `[acquirePage] geo=${proxyGeo} | 📊 Состояние пула после создания вкладки: браузеров=${pool.length}, всего вкладок=${totalTabsAfter}, среднее=${avgTabsPerBrowserAfter}/браузер`,
    );

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
          return;
        }
        if (err.message.includes('Unexpected identifier')) {
          return;
        }
        if (err.message.includes('Unexpected end of input')) {
          return;
        }
        if (err.message.includes('Invalid or unexpected token')) {
          return;
        }
        if (err.message.includes('Failed to fetch')) {
          return;
        }
        if (err.message.includes('TypeError') && err.message.includes('fetch')) {
          return;
        }

        if (err.message.includes('Cannot read properties of undefined')) {
          return;
        }
        if (err.message.includes('prototype')) {
          return;
        }
        if (err.message.includes('masterstroke_ajax is not defined')) {
          return;
        }
        if (err.message.includes('wp is not defined')) {
          return;
        }
        if (err.message.includes('i18n')) {
          return;
        }
        if (err.message.includes('hooks')) {
          return;
        }
        if (err.message.includes('ReferenceError')) {
          return;
        }
        if (err.message.includes('TypeError')) {
          return;
        }

        if (this.handleChromePropertyError(err, `Runtime error [${proxyGeo}]`)) return;
        this.logger.warn(`Runtime error [${proxyGeo}]: ${err.message}`);
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
    this.logger.info(`[diagnosePoolIssues] 🔍 Диагностика пулов браузеров...`);

    for (const [geo, pool] of this.browserPool.entries()) {
      if (pool.length === 0) continue;

      const totalTabs = pool.reduce((sum, w) => sum + w.pages.length, 0);
      const avgTabsPerBrowser = Math.round(totalTabs / pool.length);
      const utilization = Math.round((totalTabs / (pool.length * this.MAX_TABS_PER_BROWSER)) * 100);

      this.logger.info(`[diagnosePoolIssues] 📊 ${geo}:`);
      this.logger.info(`  - Browsers: ${pool.length}/${this.MAX_BROWSERS_PER_GEO}`);
      this.logger.info(`  - Tabs: ${totalTabs}/${pool.length * this.MAX_TABS_PER_BROWSER}`);
      this.logger.info(`  - Average tabs per browser: ${avgTabsPerBrowser}`);
      this.logger.info(
        `  - Utilization: ${totalTabs}/${pool.length * this.MAX_TABS_PER_BROWSER} (${utilization}%)`,
      );

      if (
        pool.length < this.MAX_BROWSERS_PER_GEO &&
        avgTabsPerBrowser >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.7)
      ) {
        this.logger.info(
          `[diagnosePoolIssues] ⚠️ ${geo}: Среднее количество вкладок ${avgTabsPerBrowser} >= ${Math.floor(this.MAX_TABS_PER_BROWSER * 0.7)}, рекомендуется создать новый браузер`,
        );
      }
    }
  }

  async forceCreateBrowsers(geo: CountryCode, count: number = 1): Promise<void> {
    const pool = this.browserPool.get(geo) || [];
    const localeSettings = LOCALE_SETTINGS[geo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;

    this.logger.info(`[forceCreateBrowsers] 🚀 Принудительно создаю ${count} браузеров для ${geo}`);

    for (let i = 0; i < count; i++) {
      if (pool.length >= this.MAX_BROWSERS_PER_GEO) {
        this.logger.warn(`[forceCreateBrowsers] Достигнут лимит браузеров для ${geo}`);
        break;
      }

      try {
        const browser = await this.createBrowser(locale, timeZone);
        const context = await browser.createBrowserContext();

        context.on('error', (err: Error) => {
          if (this.handleChromePropertyError(err, 'Context error')) return;
        });

        const wrapper = { browser, context, pages: [] };
        pool.push(wrapper);
        this.browserPool.set(geo, pool);

        this.logger.info(`[forceCreateBrowsers] ✅ Создан браузер #${pool.length} для ${geo}`);
      } catch (err) {
        this.logger.error(
          `[forceCreateBrowsers] Ошибка создания браузера для ${geo}: ${err.message}`,
        );
      }
    }

    logAllGeoPoolsTable(this.browserPool);
  }

  async cleanupPoolIssues(): Promise<void> {
    this.logger.info(`[cleanupPoolIssues] 🧹 Очистка проблемных пулов...`);

    for (const [geo, pool] of this.browserPool.entries()) {
      if (pool.length === 0) continue;

      
      for (const wrapper of pool) {
        wrapper.pages = wrapper.pages.filter((page) => !page.isClosed());
      }

      const browsersToRemove: BrowserWrapper[] = [];
      for (const wrapper of pool) {
        if (wrapper.pages.length === 0) {
          this.logger.info(`[cleanupPoolIssues] 🗑️ ${geo}: Закрываю пустой браузер`);
          try {
            await wrapper.context.close().catch(() => {});
            await wrapper.browser.close().catch(() => {});
            browsersToRemove.push(wrapper);
          } catch (error) {
            this.logger.error(
              `[cleanupPoolIssues] Ошибка закрытия браузера для ${geo}: ${error.message}`,
            );
          }
        }
      }

      
      for (const wrapper of browsersToRemove) {
        const index = pool.indexOf(wrapper);
        if (index > -1) {
          pool.splice(index, 1);
        }
      }

      if (pool.length === 0) {
        this.browserPool.delete(geo);
        this.logger.info(`[cleanupPoolIssues] 🗑️ ${geo}: Удаляю пустой гео из пула`);
      }

      const totalTabs = pool.reduce((sum, w) => sum + w.pages.length, 0);
      const avgTabsPerBrowser = Math.round(totalTabs / pool.length);

      if (
        pool.length < this.MAX_BROWSERS_PER_GEO &&
        avgTabsPerBrowser >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.8)
      ) {
        this.logger.info(
          `[cleanupPoolIssues] 🚀 ${geo}: Создаю дополнительный браузер (среднее вкладок: ${avgTabsPerBrowser})`,
        );
        try {
          const localeSettings = LOCALE_SETTINGS[geo] || LOCALE_SETTINGS.ALL;
          const { locale, timeZone } = localeSettings;
          const browser = await this.createBrowser(locale, timeZone);
          const context = await browser.createBrowserContext();

          context.on('error', (err: Error) => {
            if (this.handleChromePropertyError(err, 'Context error')) return;
          });

          const wrapper = { browser, context, pages: [] };
          pool.push(wrapper);
          this.logger.info(`[cleanupPoolIssues] ✅ ${geo}: Создан дополнительный браузер`);
        } catch (error) {
          this.logger.error(
            `[cleanupPoolIssues] Ошибка создания браузера для ${geo}: ${error.message}`,
          );
        }
      }
    }

    this.logger.info(`[cleanupPoolIssues] ✅ Очистка завершена`);
  }

  async forceCleanupEmptyBrowsers(): Promise<void> {
    this.logger.info(`[forceCleanupEmptyBrowsers] 🗑️ Принудительная очистка пустых браузеров...`);

    let totalClosed = 0;
    let totalGeosCleaned = 0;

    for (const [geo, pool] of this.browserPool.entries()) {
      if (pool.length === 0) continue;

      
      for (const wrapper of pool) {
        wrapper.pages = wrapper.pages.filter((page) => !page.isClosed());
      }

      const browsersToRemove: BrowserWrapper[] = [];
      for (const wrapper of pool) {
        if (wrapper.pages.length === 0) {
          this.logger.info(`[forceCleanupEmptyBrowsers] 🗑️ ${geo}: Закрываю пустой браузер`);
          try {
            await wrapper.context.close().catch(() => {});
            await wrapper.browser.close().catch(() => {});
            browsersToRemove.push(wrapper);
            totalClosed++;
          } catch (error) {
            this.logger.error(
              `[forceCleanupEmptyBrowsers] Ошибка закрытия браузера для ${geo}: ${error.message}`,
            );
          }
        }
      }

      for (const wrapper of browsersToRemove) {
        const index = pool.indexOf(wrapper);
        if (index > -1) {
          pool.splice(index, 1);
        }
      }

      if (pool.length === 0) {
        this.browserPool.delete(geo);
        this.logger.info(`[forceCleanupEmptyBrowsers] 🗑️ ${geo}: Удаляю пустой гео из пула`);
        totalGeosCleaned++;
      }
    }

    this.logger.info(
      `[forceCleanupEmptyBrowsers] ✅ Очистка завершена: закрыто ${totalClosed} браузеров, очищено ${totalGeosCleaned} гео`,
    );
  }

  async getPoolStatistics(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};

    for (const [geo, pool] of this.browserPool.entries()) {
      const totalTabs = pool.reduce((sum, w) => sum + w.pages.length, 0);
      const avgTabsPerBrowser = pool.length > 0 ? Math.round(totalTabs / pool.length) : 0;
      const utilization =
        pool.length > 0
          ? Math.round((totalTabs / (pool.length * this.MAX_TABS_PER_BROWSER)) * 100)
          : 0;

      stats[geo] = {
        browsers: pool.length,
        maxBrowsers: this.MAX_BROWSERS_PER_GEO,
        totalTabs,
        maxTabs: pool.length * this.MAX_TABS_PER_BROWSER,
        avgTabsPerBrowser,
        utilization: `${utilization}%`,
        canCreateMore: pool.length < this.MAX_BROWSERS_PER_GEO,
        shouldCreateMore: avgTabsPerBrowser >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.6),
      };
    }

    return stats;
  }

  async getDetailedPoolInfo(): Promise<Record<string, any>> {
    const detailedInfo: Record<string, any> = {};

    for (const [geo, pool] of this.browserPool.entries()) {
      detailedInfo[geo] = {
        browsers: pool.map((wrapper, index) => ({
          id: index + 1,
          tabs: wrapper.pages.length,
          maxTabs: this.MAX_TABS_PER_BROWSER,
          connected: wrapper.browser.isConnected(),
          utilization: `${Math.round((wrapper.pages.length / this.MAX_TABS_PER_BROWSER) * 100)}%`,
        })),
        summary: {
          totalBrowsers: pool.length,
          totalTabs: pool.reduce((sum, w) => sum + w.pages.length, 0),
          avgTabsPerBrowser:
            pool.length > 0
              ? Math.round(pool.reduce((sum, w) => sum + w.pages.length, 0) / pool.length)
              : 0,
        },
      };
    }

    return detailedInfo;
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
      this.logger.info(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | 🚀 Создаю новый браузер! pool.length=${pool.length}, MAX_BROWSERS=${this.MAX_BROWSERS_PER_GEO}`,
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

    // Если достигнут лимит браузеров, возвращаем браузер с наименьшим количеством вкладок
    this.logger.debug(
      `[getOrCreateBrowserForGeo] geo=${countryCode} | Достигнут лимит браузеров, возвращаю браузер с наименьшим количеством вкладок`,
    );
    const wrapper = pool.reduce((min, w) => (w.pages.length < min.pages.length ? w : min), pool[0]);
    return wrapper;
  }
}
