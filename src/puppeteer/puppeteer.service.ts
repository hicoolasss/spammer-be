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
  USER_AGENTS,
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
  private browserPool = new Map<CountryCode, BrowserWrapper>();

  private sanitizeModuleScript(script: string): string {
    return script.replace(/^\s*(export|import)\s.*$/gm, '');
  }

  async onModuleDestroy() {
    for (const wrapper of this.browserPool.values()) {
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
    this.browserPool.clear();
  }

  async acquirePage(
    creativeId: string,
    proxyGeo: CountryCode,
  ): Promise<{ page: Page; userAgent: string }> {
    const { locale, timeZone } = LOCALE_SETTINGS[proxyGeo];
    const userAgent = getRandomItem(USER_AGENTS);
    const wrapper = await this.ensureBrowserForGeo(proxyGeo);

    const page = await wrapper.context.newPage();
    wrapper.pages.push(page);

    try {
      await page.authenticate({
        username: process.env.PROXY_USERNAME!,
        password: `${process.env.PROXY_PASSWORD!}_country-${proxyGeo}`,
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
    page.on('pageerror', (err) =>
      this.logger.error(`Runtime error [${proxyGeo}]: ${err}`),
    );

    return { page, userAgent };
  }

  async releasePage(page: Page): Promise<void> {
    for (const [geo, wrapper] of this.browserPool.entries()) {
      const idx = wrapper.pages.indexOf(page);
      if (idx === -1) continue;

      wrapper.pages.splice(idx, 1);

      await page.setRequestInterception(false).catch(() => {});
      page.removeAllListeners('request');
      await page.close().catch(() => {});

      if (wrapper.pages.length === 0) {
        await wrapper.context.close().catch(() => {});
        await wrapper.browser.close().catch(() => {});
        this.browserPool.delete(geo);
      }

      break;
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

  private async ensureBrowserForGeo(
    countryCode: CountryCode,
  ): Promise<BrowserWrapper> {
    if (this.browserPool.has(countryCode)) {
      const wrapper = this.browserPool.get(countryCode)!;
      return wrapper;
    }

    const { locale, timeZone } = LOCALE_SETTINGS[countryCode];
    const browser = await this.createBrowser(locale, timeZone);
    const context = await browser.createBrowserContext();
    const wrapper: BrowserWrapper = { browser, context, pages: [] };
    this.browserPool.set(countryCode, wrapper);
    return wrapper;
  }
}
