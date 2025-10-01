import { CountryCode } from '@enums';
import { Injectable, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { BrowserWrapper } from '@types';
import { BROWSER_ARGUMENTS, IS_PROD_ENV, LogWrapper } from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import { getBrowserSpoofScript, getRandomItem, HEADERS, MOBILE_VIEWPORTS } from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';
import { browserOpenTimes, logAllGeoPoolsTable, pageOpenTimes } from 'src/utils/puppeteer-logging';

import { GeoRegionsService } from '../geo-regions/geo-regions.service';

@Injectable()
export class PuppeteerService implements OnModuleDestroy {
  private readonly logger = new LogWrapper(PuppeteerService.name);

  private browserPool = new Map<CountryCode, BrowserWrapper[]>();
  private geoTaskQueues = new Map<
    CountryCode,
    Array<{
      creativeId: string;
      proxyGeo: CountryCode;
      userAgent: string;
      locale: string;
      timeZone: string;
      linkurl?: string;
      resolve: (value: Page) => void;
      reject: (reason?: any) => void;
    }>
  >();
  private browserCreationLocks = new Map<CountryCode, Promise<void>>();

  private readonly MAX_BROWSERS_PER_GEO: number;
  private readonly MAX_TABS_PER_BROWSER: number;

  constructor(private readonly geoRegionsService: GeoRegionsService) {
    this.MAX_BROWSERS_PER_GEO = Number(process.env.MAX_BROWSERS_PER_GEO) || 10;
    this.MAX_TABS_PER_BROWSER = Number(process.env.MAX_TABS_PER_BROWSER) || 10;

    this.logger.info(
      `[PuppeteerService] Initialized with MAX_BROWSERS_PER_GEO=${this.MAX_BROWSERS_PER_GEO}, MAX_TABS_PER_BROWSER=${this.MAX_TABS_PER_BROWSER}`,
    );
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
    this.logger.error(`${context} error: ${err}`);
    return false;
  }

  async onModuleInit() {
    if (!process.env.PROXY_HOST) {
      this.logger.error('Proxy host is not set in environment variables');
    }

    if (!process.env.PROXY_PORT) {
      this.logger.error('Proxy port is not set in environment variables');
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

  async acquirePage(
    creativeId: string,
    proxyGeo: CountryCode,
    userAgent: string,
    linkurl?: string,
  ): Promise<Page> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
    const pool = this.browserPool.get(proxyGeo) || [];

    this.logger.debug(
      `[acquirePage] geo=${proxyGeo} | pool.length=${pool.length}, MAX_BROWSERS=${this.MAX_BROWSERS_PER_GEO}, MAX_TABS=${this.MAX_TABS_PER_BROWSER}`,
    );

    const getBrowserWithFreeSlot = () =>
      pool.find((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);

    const hasAvailableSlots = () => {
      const totalSlots = pool.length * this.MAX_TABS_PER_BROWSER;
      const usedSlots = pool.reduce((sum, w) => sum + w.pages.length, 0);
      return usedSlots < totalSlots;
    };

    const canCreateNewBrowser = () => pool.length < this.MAX_BROWSERS_PER_GEO;

    let wrapper = getBrowserWithFreeSlot();

    if (wrapper) {
      this.logger.debug(
        `[acquirePage] geo=${proxyGeo} | Найден браузер с ${wrapper.pages.length} вкладками, добавляю вкладку`,
      );
      const page = await this._openPage(wrapper, userAgent, locale, timeZone, proxyGeo, linkurl);
      logAllGeoPoolsTable(this.browserPool);
      return page;
    }

    if (hasAvailableSlots() || canCreateNewBrowser()) {
      this.logger.debug(
        `[acquirePage] geo=${proxyGeo} | Нет браузера со свободным слотом, но есть возможности. hasAvailableSlots=${hasAvailableSlots()}, canCreateNewBrowser=${canCreateNewBrowser()}`,
      );

      if (canCreateNewBrowser()) {
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
            const page = await this._openPage(
              newWrapper,
              userAgent,
              locale,
              timeZone,
              proxyGeo,
              linkurl,
            );
            this._drainGeoQueue(proxyGeo);
            logAllGeoPoolsTable(this.browserPool);
            return page;
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
            const page = await this._openPage(
              wrapper,
              userAgent,
              locale,
              timeZone,
              proxyGeo,
              linkurl,
            );
            logAllGeoPoolsTable(this.browserPool);
            return page;
          }
        }
      } else {
        this.logger.debug(
          `[acquirePage] geo=${proxyGeo} | Достигнут лимит браузеров, но есть свободные слоты. Ждем освобождения...`,
        );

        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));

          const updatedPool = this.browserPool.get(proxyGeo) || [];
          wrapper = updatedPool.find((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);

          if (wrapper) {
            this.logger.debug(
              `[acquirePage] geo=${proxyGeo} | Найден свободный слот после ожидания, добавляю вкладку`,
            );
            const page = await this._openPage(
              wrapper,
              userAgent,
              locale,
              timeZone,
              proxyGeo,
              linkurl,
            );
            logAllGeoPoolsTable(this.browserPool);
            return page;
          }
        }
      }
    }

    this.logger.debug(
      `[acquirePage] geo=${proxyGeo} | Все браузеры заполнены и лимит достигнут, ставлю задачу в очередь`,
    );
    return new Promise<Page>((resolve, reject) => {
      if (!this.geoTaskQueues.has(proxyGeo)) {
        this.geoTaskQueues.set(proxyGeo, []);
      }
      this.geoTaskQueues.get(proxyGeo)!.push({
        creativeId,
        proxyGeo,
        userAgent,
        locale,
        timeZone,
        linkurl,
        resolve,
        reject,
      });
    });
  }

  private async _openPage(
    wrapper: BrowserWrapper,
    userAgent: string,
    locale: string,
    timeZone: string,
    proxyGeo: CountryCode,
    linkurl?: string,
  ): Promise<Page> {
    if (wrapper.pages.length >= this.MAX_TABS_PER_BROWSER) {
      this.logger.error(
        `[_openPage] geo=${proxyGeo} | Попытка открыть вкладку при переполнении: уже ${wrapper.pages.length} вкладок (лимит ${this.MAX_TABS_PER_BROWSER})`,
      );
      throw new Error('MAX_TABS limit reached for this browser');
    }

    const page = await wrapper.context.newPage();
    const pageOpenTime = Date.now();
    pageOpenTimes.set(page, pageOpenTime);
    wrapper.pages.push(page);

    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders(HEADERS(locale, userAgent, linkurl));
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
      if (this.handleChromePropertyError(err, `Page error [${proxyGeo}]`)) return;
    });

    page.on('pageerror', (err) => {
      if (err?.message?.includes('setCookie is not defined')) {
        return;
      }
      if (this.handleChromePropertyError(err, `Runtime error [${proxyGeo}]`)) return;
      this.logger.error(`Runtime error [${proxyGeo}]: ${err}`);
    });

    return page;
  }

  async releasePage(page: Page, geo: CountryCode): Promise<void> {
    const pool = this.browserPool.get(geo) || [];

    for (const wrapper of pool) {
      const idx = wrapper.pages.indexOf(page);

      if (idx === -1) continue;

      const pageOpenTime = pageOpenTimes.get(page);
      this.logger.debug(
        `[releasePage] geo=${geo} | Закрываю вкладку, время жизни: ${pageOpenTime ? Date.now() - pageOpenTime : 'unknown'}ms`,
      );

      wrapper.pages.splice(idx, 1);
      pageOpenTimes.delete(page);

      await page.setRequestInterception(false).catch(() => {});
      page.removeAllListeners('request');
      await page.close().catch(() => {});

      if (wrapper.pages.length === 0) {
        await wrapper.context.close().catch(() => {});
        await wrapper.browser.close().catch(() => {});
        pool.splice(pool.indexOf(wrapper), 1);

        if (pool.length === 0) {
          this.browserPool.delete(geo);
        }
      }

      logAllGeoPoolsTable(this.browserPool);

      this._drainGeoQueue(geo);
      return;
    }
  }

  private async createBrowser(
    locale: string,
    timeZone: string,
    countryCode: CountryCode,
  ): Promise<Browser> {
    dns.setServers(['1.1.1.1']);
    let browser: Browser;

    try {
      const proxyInfo = await this.geoRegionsService.getGeoProxy(countryCode);
      const proxy = `--proxy-server=http://${proxyInfo.host}:${proxyInfo.port} --proxy-auth=${proxyInfo.username}:${proxyInfo.password}`;
      browser = await launch({
        headless: IS_PROD_ENV,
        dumpio: true,
        pipe: true,
        args: BROWSER_ARGUMENTS(proxy, locale, timeZone),
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

      const browser = await this.createBrowser(locale, timeZone, countryCode);
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

  private hasAvailableSlot(geo: CountryCode): boolean {
    const pool = this.browserPool.get(geo) || [];

    const hasAvailableBrowser = pool.some((w) => w.pages.length < this.MAX_TABS_PER_BROWSER);
    if (hasAvailableBrowser) return true;

    if (pool.length < this.MAX_BROWSERS_PER_GEO) return true;

    return false;
  }

  private async _drainGeoQueue(geo: CountryCode) {
    const currentPool = this.browserPool.get(geo) || [];
    const queue = this.geoTaskQueues.get(geo);

    if (!queue || queue.length === 0) {
      return;
    }

    this.logger.debug(
      `[_drainGeoQueue] geo=${geo} | Обрабатываю очередь: ${queue.length} задач, pool: ${currentPool.length} браузеров`,
    );

    const getFreeSlots = () => {
      return currentPool.reduce((acc, w) => acc + (this.MAX_TABS_PER_BROWSER - w.pages.length), 0);
    };

    const canCreateNewBrowser = () => currentPool.length < this.MAX_BROWSERS_PER_GEO;

    let processedCount = 0;
    let freeSlots = getFreeSlots();

    while (queue.length > 0 && (freeSlots > 0 || canCreateNewBrowser())) {
      const next = queue.shift();
      if (!next) break;

      if (freeSlots > 0) {
        this.logger.debug(
          `[_drainGeoQueue] geo=${geo} | Запускаю задачу из очереди, свободных слотов: ${freeSlots}`,
        );
        this.acquirePage(next.creativeId, next.proxyGeo, next.userAgent, next.linkurl)
          .then(next.resolve)
          .catch(next.reject);
        freeSlots--;
        processedCount++;
      } else if (canCreateNewBrowser()) {
        this.logger.debug(
          `[_drainGeoQueue] geo=${geo} | Нет свободных слотов, но можно создать новый браузер — инициирую acquirePage для очереди`,
        );
        this.acquirePage(next.creativeId, next.proxyGeo, next.userAgent, next.linkurl)
          .then(next.resolve)
          .catch(next.reject);
        processedCount++;
      }
    }

    if (processedCount > 0) {
      this.logger.info(
        `[_drainGeoQueue] geo=${geo} | Обработано ${processedCount} задач из очереди. Осталось: ${queue.length}`,
      );
    }

    if (queue.length > 0) {
      this.logger.debug(
        `[_drainGeoQueue] geo=${geo} | Осталось задач в очереди: ${queue.length}. Свободных слотов: ${getFreeSlots()}, можно создать браузер: ${canCreateNewBrowser()}`,
      );
    }

    logAllGeoPoolsTable(this.browserPool);
  }

  getBrowserStats(): {
    totalBrowsers: number;
    totalPages: number;
    geoStats: Record<
      string,
      {
        browsers: number;
        pages: number;
        freeSlots: number;
        queueLength: number;
      }
    >;
  } {
    const stats = {
      totalBrowsers: 0,
      totalPages: 0,
      geoStats: {} as Record<
        string,
        {
          browsers: number;
          pages: number;
          freeSlots: number;
          queueLength: number;
        }
      >,
    };

    for (const [geo, pool] of this.browserPool.entries()) {
      const browsers = pool.length;
      const pages = pool.reduce((sum, w) => sum + w.pages.length, 0);
      const freeSlots = pool.reduce(
        (sum, w) => sum + (this.MAX_TABS_PER_BROWSER - w.pages.length),
        0,
      );
      const queueLength = this.geoTaskQueues.get(geo)?.length || 0;

      stats.totalBrowsers += browsers;
      stats.totalPages += pages;
      stats.geoStats[geo] = {
        browsers,
        pages,
        freeSlots,
        queueLength,
      };
    }

    return stats;
  }
}
