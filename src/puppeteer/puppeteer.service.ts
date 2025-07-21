import { CountryCode } from '@enums';
import {
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
} from '@nestjs/common';
import { BrowserWrapper } from '@types';
import {
  BLACKLISTED_DOMAINS,
  BLACKLISTED_PARAMS,
  BLACKLISTED_SCRIPTS,
  LogWrapper,
  UBLOCK_RAW_RULES,
} from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import {
  getLocaleOverrideScript,
  getRandomItem,
  HEADERS,
  MOBILE_VIEWPORTS,
} from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';

const ALLOWLIST: RegExp[] = [];
const BLOCKLIST: RegExp[] = [];

UBLOCK_RAW_RULES.forEach((rule) => {
  if (rule.startsWith('@@')) {
    ALLOWLIST.push(convertRuleToRegExp(rule.slice(2)));
  } else {
    BLOCKLIST.push(convertRuleToRegExp(rule));
  }
});

function convertRuleToRegExp(rule: string): RegExp {
  const escaped = rule
    .replace(/\*/g, '.*')
    .replace(/\^/g, '(?:[^a-zA-Z0-9_.%-]|$)')
    .replace(/\//g, '\\/')
    .replace(/\?/g, '\\?');
  const full = escaped.startsWith('||')
    ? '^https?:\\/\\/' + escaped.slice(2)
    : escaped;
  return new RegExp(full, 'i');
}

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

  async acquirePage(
    creativeId: string,
    proxyGeo: CountryCode,
    userAgent: string,
  ): Promise<Page> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    const pool = this.browserPool.get(proxyGeo) || [];

    this.logger.debug(
      `[acquirePage] geo=${proxyGeo} | browsers=${pool.length} | tabs=[${pool.map((w) => w.pages.length).join(',')}] | reserved=[${pool.map((w) => w.reservedTabs).join(',')}] | queue=${this.geoTaskQueues.get(proxyGeo)?.length || 0}`,
    );

    this.logger.debug(`[acquirePage] pool = ${pool}.`);
    const getBrowserWithFreeSlot = () =>
      pool.find((w) => w.reservedTabs < MAX_TABS);
    let wrapper = getBrowserWithFreeSlot();
    if (wrapper) {
      wrapper.reservedTabs++;
      this.logger.debug(
        `[acquirePage] geo=${proxyGeo} | Резервирую слот в браузере с ${wrapper.pages.length} вкладками (reservedTabs=${wrapper.reservedTabs})`,
      );
      try {
        const page = await this._openPage(
          wrapper,
          userAgent,
          locale,
          timeZone,
          creativeId,
          proxyGeo,
        );
        return page;
      } catch (err) {
        wrapper.reservedTabs--;
        throw err;
      }
    }

    if (pool.length < MAX_BROWSERS) {
      if (!this.browserCreationLocks.has(proxyGeo)) {
        this.logger.debug(
          `[acquirePage] geo=${proxyGeo} | Создаю новый браузер...`,
        );
        let resolveLock;
        const lockPromise = new Promise<void>((resolve) => {
          resolveLock = resolve;
        });
        this.browserCreationLocks.set(proxyGeo, lockPromise);
        try {
          const newWrapper = await this.getOrCreateBrowserForGeo(
            proxyGeo,
            locale,
            timeZone,
          );
          newWrapper.reservedTabs = 1;
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | Новый браузер создан, резервирую слот и открываю вкладку`,
          );
          try {
            const page = await this._openPage(
              newWrapper,
              userAgent,
              locale,
              timeZone,
              creativeId,
              proxyGeo,
            );
            this.logger.debug(
              `[acquirePage] geo=${proxyGeo} | После создания браузера: this.browserPool.has(${proxyGeo})=${this.browserPool.has(proxyGeo)}, pool.length=${this.browserPool.get(proxyGeo)?.length || 0}`,
            );
            this._drainGeoQueue(proxyGeo, [], MAX_TABS);
            return page;
          } catch (err) {
            newWrapper.reservedTabs = 0;
            throw err;
          }
        } finally {
          this.browserCreationLocks.delete(proxyGeo);
          resolveLock();
        }
      } else {
        this.logger.debug(
          `[acquirePage] geo=${proxyGeo} | Жду создания браузера другим потоком...`,
        );
        await this.browserCreationLocks.get(proxyGeo);
        const updatedPool = this.browserPool.get(proxyGeo) || [];
        wrapper = updatedPool.find((w) => w.reservedTabs < MAX_TABS);
        if (wrapper) {
          wrapper.reservedTabs++;
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | После ожидания: резервирую слот и открываю вкладку в браузер с ${wrapper.pages.length} вкладками (reservedTabs=${wrapper.reservedTabs})`,
          );
          try {
            const page = await this._openPage(
              wrapper,
              userAgent,
              locale,
              timeZone,
              creativeId,
              proxyGeo,
            );
            return page;
          } catch (err) {
            wrapper.reservedTabs--;
            throw err;
          }
        }
      }
    }

    if (pool.length < MAX_BROWSERS) {
      if (!this.browserCreationLocks.has(proxyGeo)) {
        this.logger.debug(
          `[acquirePage] geo=${proxyGeo} | Все браузеры заполнены, но лимит не достигнут — создаю новый браузер для очередной задачи`,
        );
        let resolveLock;
        const lockPromise = new Promise<void>((resolve) => {
          resolveLock = resolve;
        });
        this.browserCreationLocks.set(proxyGeo, lockPromise);
        try {
          const newWrapper = await this.getOrCreateBrowserForGeo(
            proxyGeo,
            locale,
            timeZone,
          );
          newWrapper.reservedTabs = 1;
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | Новый браузер создан (по очереди), резервирую слот и открываю вкладку`,
          );
          try {
            const page = await this._openPage(
              newWrapper,
              userAgent,
              locale,
              timeZone,
              creativeId,
              proxyGeo,
            );
            this._drainGeoQueue(proxyGeo, [], MAX_TABS);
            return page;
          } catch (err) {
            newWrapper.reservedTabs = 0;
            throw err;
          }
        } finally {
          this.browserCreationLocks.delete(proxyGeo);
          resolveLock();
        }
      } else {
        this.logger.debug(
          `[acquirePage] geo=${proxyGeo} | Все браузеры заполнены, жду создания браузера другим потоком (по очереди)...`,
        );
        await this.browserCreationLocks.get(proxyGeo);
        const updatedPool = this.browserPool.get(proxyGeo) || [];
        wrapper = updatedPool.find((w) => w.reservedTabs < MAX_TABS);
        if (wrapper) {
          wrapper.reservedTabs++;
          this.logger.debug(
            `[acquirePage] geo=${proxyGeo} | После ожидания (по очереди): резервирую слот и открываю вкладку в браузер с ${wrapper.pages.length} вкладками (reservedTabs=${wrapper.reservedTabs})`,
          );
          try {
            const page = await this._openPage(
              wrapper,
              userAgent,
              locale,
              timeZone,
              creativeId,
              proxyGeo,
            );
            return page;
          } catch (err) {
            wrapper.reservedTabs--;
            throw err;
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
    if (wrapper.reservedTabs >= MAX_TABS) {
      this.logger.error(
        `[_openPage] geo=${proxyGeo} | Попытка открыть вкладку при переполнении: уже ${wrapper.reservedTabs} вкладок (лимит ${MAX_TABS})`,
      );
      throw new Error('MAX_TABS limit reached for this browser');
    }
    this.logger.debug(
      `[_openPage] geo=${proxyGeo} | Открываю вкладку в браузер с ${wrapper.pages.length} вкладками`,
    );

    const page = await wrapper.context.newPage();
    wrapper.pages.push(page);

    this.logger.debug(
      `[_openPage] geo=${proxyGeo} | Вкладка открыта, теперь браузер имеет ${wrapper.pages.length} вкладок`,
    );

    try {
      await page.authenticate({
        username: process.env.PROXY_USERNAME,
        password: `${process.env.PROXY_PASSWORD}_country-${proxyGeo}`,
      });
    } catch {
      // Ignore
    }

    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders(HEADERS(locale));
    await page.emulateTimezone(timeZone);

    const localeRaw = getLocaleOverrideScript(locale, timeZone);
    const localeScript = this.sanitizeModuleScript(localeRaw);

    await page.evaluateOnNewDocument(`(()=>{${localeScript}})();`);
    const maxTouchPoints = Math.floor(Math.random() * 6) + 5;
    await page.evaluateOnNewDocument(`
      Object.defineProperty(navigator, 'platform', {get: () => 'Linux armv81'});
      Object.defineProperty(navigator, 'maxTouchPoints', {get: () => ${maxTouchPoints}});
    `);

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
      const url = req.url();
      const urlLower = url.toLowerCase();
      const type = req.resourceType();

      if (
        type === 'script' &&
        BLACKLISTED_SCRIPTS.some((s) => urlLower.includes(s))
      ) {
        this.logger.debug(
          `[${creativeId}] Blocked by script rule → ${urlLower}`,
        );
        return req.abort();
      }

      const strictPatterns = [
        /kmnrkey/i,
        /knmrkey/i,
        /bean-script/i,
        /afrdtech\.com/i,
        /kaminari\.(space|systems|click)/i,
        /\/v[0-9]+\/(check|append)/i,
      ];

      if (strictPatterns.some((pattern) => pattern.test(url))) {
        this.logger.debug(`[${creativeId}] Blocked by strict pattern → ${url}`);
        return req.abort();
      }

      try {
        const hostname = new URL(url).hostname.toLowerCase();
        const isDomainBlocked = BLACKLISTED_DOMAINS.some(
          (domain) => hostname === domain || hostname.endsWith('.' + domain),
        );

        if (isDomainBlocked) {
          this.logger.debug(`[${creativeId}] Blocked by domain rule → ${url}`);
          return req.abort();
        }
      } catch {
        // Ignore
      }

      if (ALLOWLIST.some((r) => r.test(urlLower))) {
        return req.continue();
      }

      if (BLOCKLIST.some((r) => r.test(urlLower))) {
        this.logger.debug(
          `[${creativeId}] Blocked by uBlock rule → ${urlLower}`,
        );
        return req.abort();
      }

      if (BLACKLISTED_DOMAINS.some((domain) => urlLower.includes(domain))) {
        this.logger.debug(
          `[${creativeId}] Blocked by domain rule → ${urlLower}`,
        );
        return req.abort();
      }

      if (
        (type === 'xhr' || type === 'fetch') &&
        BLACKLISTED_PARAMS.some(
          (p) => url.includes(`?${p}`) || urlLower.includes(`&${p}`),
        )
      ) {
        this.logger.debug(
          `[${creativeId}] Blocked by param rule → ${urlLower}`,
        );
        return req.abort();
      }

      return req.continue();
    });
    page.on('error', (err) =>
      this.logger.error(`Page error [${proxyGeo}]: ${err}`),
    );
    page.on('pageerror', (err) => {
      if (err.message.includes('setCookie is not defined')) {
        this.logger.debug(
          `Ignoring setCookie error [${proxyGeo}]: ${err.message}`,
        );
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
      wrapper.reservedTabs--;
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
      this.logger.debug(
        `[releasePage] geo=${geo} | Освобождён слот, browsers=${pool.length}, tabs=[${pool.map((w) => w.pages.length).join(',')}]`,
      );

      const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
      this._drainGeoQueue(geo, [], MAX_TABS);
      return;
    }
  }

  private async createBrowser(
    locale: string,
    timeZone: string,
  ): Promise<Browser> {
    dns.setServers(['1.1.1.1']);
    let browser: Browser;
    try {
      browser = await launch({
        headless: false,
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
      throw new InternalServerErrorException(
        `Failed to launch browser: ${e.message}`,
      );
    }
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
    } catch {
      // Ignore
    }
    browser.on('disconnected', () => {
      this.browserPool.delete(locale as unknown as CountryCode);
    });
    return browser;
  }

  private async getOrCreateBrowserForGeo(
    countryCode: CountryCode,
    locale: string,
    timeZone: string,
  ): Promise<BrowserWrapper> {
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    let totalBrowsers = 0;
    for (const pool of this.browserPool.values()) {
      totalBrowsers += pool.length;
    }
    const pool = this.browserPool.get(countryCode) || [];
    let wrapper = pool.find((w) => w.reservedTabs < MAX_TABS);
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
      wrapper = { browser, context, pages: [], reservedTabs: 0 };
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
      if (
        geo !== countryCode &&
        geoPool.length > maxCount &&
        geoPool.length > 1
      ) {
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
      wrapper = { browser, context, pages: [], reservedTabs: 0 };
      pool.push(wrapper);
      this.browserPool.set(countryCode, pool);
      return wrapper;
    }

    wrapper = pool.reduce(
      (min, w) => (w.pages.length < min.pages.length ? w : min),
      pool[0],
    );
    return wrapper;
  }

  private hasAvailableSlot(geo: CountryCode): boolean {
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    const MAX_TABS = Number(process.env.MAX_TABS_PER_BROWSER) || 15;
    const pool = this.browserPool.get(geo) || [];

    const hasAvailableBrowser = pool.some((w) => w.reservedTabs < MAX_TABS);
    if (hasAvailableBrowser) return true;

    if (pool.length < MAX_BROWSERS) return true;

    return false;
  }

  private async _drainGeoQueue(
    geo: CountryCode,
    pool: BrowserWrapper[],
    MAX_TABS: number,
  ) {
    const currentPool = this.browserPool.get(geo) || [];
    const queue = this.geoTaskQueues.get(geo);
    let freeSlots = currentPool.reduce(
      (acc, w) => acc + (MAX_TABS - w.reservedTabs),
      0,
    );
    const MAX_BROWSERS = Number(process.env.MAX_BROWSERS_PER_GEO) || 5;
    this.logger.debug(
      `[_drainGeoQueue] geo=${geo} | browsers=${currentPool.length} | tabs=[${currentPool.map((w) => w.pages.length).join(',')}] | reserved=[${currentPool.map((w) => w.reservedTabs).join(',')}] | freeSlots=${freeSlots} | queueLength=${queue?.length || 0}`,
    );
    while (
      queue &&
      queue.length > 0 &&
      (freeSlots > 0 || currentPool.length < MAX_BROWSERS)
    ) {
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
      this.logger.debug(
        `[_drainGeoQueue] geo=${geo} | Осталось задач в очереди: ${queue.length}`,
      );
    }
  }
}
