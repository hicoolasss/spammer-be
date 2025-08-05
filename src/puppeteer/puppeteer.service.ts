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
  private geoTaskQueues = new Map<
    CountryCode,
    Array<{
      creativeId: string;
      proxyGeo: CountryCode;
      userAgent: string;
      locale: string;
      timeZone: string;
      resolve: (value: Page) => void;
      reject: (reason?: any) => void;
    }>
  >();
  private browserCreationLocks = new Map<CountryCode, Promise<void>>();

  private sanitizeModuleScript(script: string): string {
    return script.replace(/^\s*(export|import)\s.*$/gm, '');
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

  async acquirePage(creativeId: string, proxyGeo: CountryCode, userAgent: string): Promise<Page> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    const pool = this.browserPool.get(proxyGeo) || [];

    const getBrowserWithFreeSlot = () => pool.find((w) => w.pages.length < MAX_TABS);
    let wrapper = getBrowserWithFreeSlot();
    if (wrapper) {
      const page = await this._openPage(wrapper, userAgent, locale, timeZone, creativeId, proxyGeo);
      logAllGeoPoolsTable(this.browserPool);
      return page;
    }

    if (pool.length < MAX_BROWSERS) {
      if (!this.browserCreationLocks.has(proxyGeo)) {
        const lockPromise = new Promise<void>((resolve) => {
          resolve();
        });
        this.browserCreationLocks.set(proxyGeo, lockPromise);
        let newWrapper: BrowserWrapper;
        try {
          newWrapper = await this.getOrCreateBrowserForGeo(proxyGeo, locale, timeZone);
          newWrapper.pages.push(
            await this._openPage(newWrapper, userAgent, locale, timeZone, creativeId, proxyGeo),
          );
          this._drainGeoQueue(proxyGeo, this.browserPool.get(proxyGeo) || [], MAX_TABS);
          logAllGeoPoolsTable(this.browserPool);
          return newWrapper.pages[0];
        } catch (err) {
          if (newWrapper) newWrapper.pages = [];
          throw err;
        }
      } else {
        await this.browserCreationLocks.get(proxyGeo);
        const updatedPool = this.browserPool.get(proxyGeo) || [];
        wrapper = updatedPool.find((w) => w.pages.length < MAX_TABS);
        if (wrapper) {
          const page = await this._openPage(
            wrapper,
            userAgent,
            locale,
            timeZone,
            creativeId,
            proxyGeo,
          );
          logAllGeoPoolsTable(this.browserPool);
          return page;
        }
      }
    }

    if (pool.length < MAX_BROWSERS) {
      if (!this.browserCreationLocks.has(proxyGeo)) {
        const lockPromise = new Promise<void>((resolve) => {
          resolve();
        });
        this.browserCreationLocks.set(proxyGeo, lockPromise);
        let newWrapper: BrowserWrapper;
        try {
          newWrapper = await this.getOrCreateBrowserForGeo(proxyGeo, locale, timeZone);
          newWrapper.pages.push(
            await this._openPage(newWrapper, userAgent, locale, timeZone, creativeId, proxyGeo),
          );
          this._drainGeoQueue(proxyGeo, this.browserPool.get(proxyGeo) || [], MAX_TABS);
          logAllGeoPoolsTable(this.browserPool);
          return newWrapper.pages[0];
        } catch (err) {
          if (newWrapper) newWrapper.pages = [];
          throw err;
        }
      } else {
        await this.browserCreationLocks.get(proxyGeo);
        const updatedPool = this.browserPool.get(proxyGeo) || [];
        wrapper = updatedPool.find((w) => w.pages.length < MAX_TABS);
        if (wrapper) {
          const page = await this._openPage(
            wrapper,
            userAgent,
            locale,
            timeZone,
            creativeId,
            proxyGeo,
          );
          logAllGeoPoolsTable(this.browserPool);
          return page;
        }
      }
    }
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
    creativeId: string,
    proxyGeo: CountryCode,
  ): Promise<Page> {
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    if (wrapper.pages.length >= MAX_TABS) {
      this.logger.error(
        `[_openPage] geo=${proxyGeo} | Попытка открыть вкладку при переполнении: уже ${wrapper.pages.length} вкладок (лимит ${MAX_TABS})`,
      );
      throw new Error('MAX_TABS limit reached for this browser');
    }

    const page = await wrapper.context.newPage();
    pageOpenTimes.set(page, Date.now());
    wrapper.pages.push(page);

    try {
      await page.authenticate({
        username: process.env.PROXY_USERNAME,
        password: `${process.env.PROXY_PASSWORD}_country-${proxyGeo}`,
      });
    } catch (e) {
      this.logger.error(`Error in page.authenticate: ${e.message}`);
    }

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
    page.on('error', (err) => this.logger.error(`Page error [${proxyGeo}]: ${err}`));
    page.on('pageerror', (err) => {
      if (err.message.includes('setCookie is not defined')) {
        return;
      }
      this.logger.error(`Runtime error [${proxyGeo}]: ${err}`);
    });

    return page;
  }

  async releasePage(page: Page, geo: CountryCode): Promise<void> {
    const pool = this.browserPool.get(geo) || [];

    for (const wrapper of pool) {
      const idx = wrapper.pages.indexOf(page);

      if (idx === -1) continue;

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

      const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
      this._drainGeoQueue(geo, pool, MAX_TABS);
      return;
    }
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
    return browser;
  }

  private async getOrCreateBrowserForGeo(
    countryCode: CountryCode,
    locale: string,
    timeZone: string,
  ): Promise<BrowserWrapper> {
    this.logger.debug(
      `[DEBUG] getOrCreateBrowserForGeo called with countryCode=${countryCode}, locale=${locale}, timeZone=${timeZone}`,
    );
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    let totalBrowsers = 0;
    for (const pool of this.browserPool.values()) {
      totalBrowsers += pool.length;
    }
    const pool = this.browserPool.get(countryCode) || [];
    let wrapper = pool.find((w) => w.pages.length < MAX_TABS);
    if (wrapper) {
      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | Найден существующий браузер с ${wrapper.pages.length} вкладками`,
      );
      return wrapper;
    }
    if (totalBrowsers < MAX_BROWSERS) {
      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | Создаю новый браузер, totalBrowsers=${totalBrowsers}, MAX_BROWSERS=${MAX_BROWSERS}`,
      );
      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | До создания: this.browserPool.has(${countryCode})=${this.browserPool.has(countryCode)}, pool.length=${pool.length}`,
      );

      const browser = await this.createBrowser(locale, timeZone);
      const context = await browser.createBrowserContext();
      wrapper = { browser, context, pages: [] };
      pool.push(wrapper);
      this.browserPool.set(countryCode, pool);

      this.logger.debug(
        `[getOrCreateBrowserForGeo] geo=${countryCode} | После создания: this.browserPool.has(${countryCode})=${this.browserPool.has(countryCode)}, pool.length=${pool.length}, this.browserPool.get(${countryCode}).length=${this.browserPool.get(countryCode)?.length || 0}`,
      );
      return wrapper;
    }
    let maxGeo: CountryCode | null = null;
    let maxCount = 0;
    for (const [geo, geoPool] of this.browserPool.entries()) {
      if (geo !== countryCode && geoPool.length > maxCount && geoPool.length > 1) {
        maxGeo = geo;
        maxCount = geoPool.length;
      }
    }
    if (maxGeo) {
      const geoPool = this.browserPool.get(maxGeo)!;
      const browserToClose = geoPool.pop();
      if (browserToClose) {
        await browserToClose.context.close().catch(() => {});
        await browserToClose.browser.close().catch(() => {});
      }
      if (geoPool.length === 0) {
        this.browserPool.delete(maxGeo);
      }
      const browser = await this.createBrowser(locale, timeZone);
      const context = await browser.createBrowserContext();
      wrapper = { browser, context, pages: [] };
      pool.push(wrapper);
      this.browserPool.set(countryCode, pool);
      return wrapper;
    }

    wrapper = pool.reduce((min, w) => (w.pages.length < min.pages.length ? w : min), pool[0]);
    return wrapper;
  }

  private hasAvailableSlot(geo: CountryCode): boolean {
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    const pool = this.browserPool.get(geo) || [];

    const hasAvailableBrowser = pool.some((w) => w.pages.length < MAX_TABS);
    if (hasAvailableBrowser) return true;

    if (pool.length < MAX_BROWSERS) return true;

    return false;
  }

  private async _drainGeoQueue(geo: CountryCode, pool: BrowserWrapper[], MAX_TABS: number) {
    const currentPool = this.browserPool.get(geo) || [];
    const queue = this.geoTaskQueues.get(geo);
    let freeSlots = currentPool.reduce((acc, w) => acc + (MAX_TABS - w.pages.length), 0);
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    this.logger.debug(
      `[_drainGeoQueue] geo=${geo} | browsers=${currentPool.length} | tabs=[${currentPool.map((w) => w.pages.length).join(',')}] | reserved=[${currentPool.map((w) => w.pages.length).join(',')}] | freeSlots=${freeSlots} | queueLength=${queue?.length || 0} | passedPoolLength=${pool.length}`,
    );
    while (queue && queue.length > 0 && (freeSlots > 0 || currentPool.length < MAX_BROWSERS)) {
      const next = queue.shift();
      if (!next) break;

      if (freeSlots > 0) {
        this.logger.debug(
          `[_drainGeoQueue] geo=${geo} | Запускаю задачу из очереди, осталось слотов: ${freeSlots}`,
        );
        this.acquirePage(next.creativeId, next.proxyGeo, next.userAgent)
          .then(next.resolve)
          .catch(next.reject);
        freeSlots--;
      } else if (currentPool.length < MAX_BROWSERS) {
        this.logger.debug(
          `[_drainGeoQueue] geo=${geo} | Нет свободных вкладок, но можно создать новый браузер — инициирую acquirePage для очереди`,
        );
        this.acquirePage(next.creativeId, next.proxyGeo, next.userAgent)
          .then(next.resolve)
          .catch(next.reject);
      }
    }
    if (queue && queue.length > 0) {
      this.logger.debug(`[_drainGeoQueue] geo=${geo} | Осталось задач в очереди: ${queue.length}`);
    }
    logAllGeoPoolsTable(this.browserPool);
  }
}
