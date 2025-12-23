import { CountryCode } from '@enums';
import { Injectable, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { BROWSER_ARGUMENTS, IS_PROD_ENV, LogWrapper } from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import { getBrowserSpoofScript, getRandomItem, HEADERS, MOBILE_VIEWPORTS } from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';
import { ProxyConfig } from 'src/types/proxy.types';
import { browserOpenTimes } from 'src/utils/puppeteer-logging';

const PROXIES: ProxyConfig[] = [
  {
    name: 'PacketStream-CZ',
    host: process.env.PS_CZ_PROXY_HOST!,
    port: Number(process.env.PS_CZ_PROXY_PORT!),
    username: process.env.PS_CZ_PROXY_USERNAME!,
    password: process.env.PS_CZ_PROXY_PASSWORD!,
  },
  {
    name: 'PIA-CZ',
    host: process.env.PIA_CZ_PROXY_HOST!,
    port: Number(process.env.PIA_CZ_PROXY_PORT!),
    username: process.env.PIA_CZ_PROXY_USERNAME!,
    password: process.env.PIA_CZ_PROXY_PASSWORD!,
  },
];

@Injectable()
export class PuppeteerService implements OnModuleDestroy {
  private readonly logger = new LogWrapper(PuppeteerService.name);

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
    for (const [i, p] of PROXIES.entries()) {
      if (!p.host || !p.port || !p.username || !p.password) {
        this.logger.error(`[PuppeteerService] Proxy #${i} (${p.name}) is not fully configured`);
      }
    }
  }

  async onModuleDestroy() {}

  async createIsolatedPage(
    taskId: string,
    proxyGeo: CountryCode,
    userAgent: string,
    linkurl?: string,
  ): Promise<{ browser: Browser; page: Page }> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
  
    const proxy = this.getNextProxy(taskId);
  
    const browser = await this.createBrowser(locale, timeZone, proxy);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
  
    try {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    } catch (e) {
      this.logger.error(
        `[PuppeteerService] page.authenticate error for "${proxy.name}": ${e.message}`,
      );
    }
  
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
    page.on('request', (req) => req.continue());
  
    return { browser, page };
  }

  private async createBrowser(
    locale: string,
    timeZone: string,
    proxy: ProxyConfig,
  ): Promise<Browser> {
    dns.setServers(['1.1.1.1']);
  
    this.logger.debug(
      `[createBrowser] proxy="${proxy.name}" ${proxy.host}:${proxy.port} timeZone=${timeZone} locale=${locale}`,
    );
  
    try {
      const proxyArg = `--proxy-server=http://${proxy.host}:${proxy.port}`;
  
      const browser = await launch({
        headless: IS_PROD_ENV,
        dumpio: true,
        pipe: true,
        args: BROWSER_ARGUMENTS(proxyArg, locale, timeZone),
        slowMo: 0,
        defaultViewport: null,
      });
  
      // try {
      //   const pages = await browser.pages();
      //   await Promise.all(pages.map((p) => p.close()));
      // } catch {
      //   // Ignore
      // }
  
      browserOpenTimes.set(browser, Date.now());
  
      browser.on('disconnected', () => {
        this.logger.warn(
          `[createBrowser] Browser disconnected (proxy="${proxy.name}" ${proxy.host}:${proxy.port})`,
        );
      });
  
      browser.on('error', (err: Error) => {
        if (this.handleChromePropertyError(err, 'Browser error')) return;
      });
  
      return browser;
    } catch (e: any) {
      throw new InternalServerErrorException(`Failed to launch browser: ${e?.message ?? e}`);
    }
  }

  private taskProxyIndex = new Map<string, number>();

  private getNextProxy(taskId: string): ProxyConfig {
    if (PROXIES.length === 0) throw new Error('No proxies configured');

    const idx = this.taskProxyIndex.get(taskId) ?? 0;
    const proxy = PROXIES[idx % PROXIES.length];

    this.taskProxyIndex.set(taskId, idx + 1);

    this.logger.debug(
      `[PuppeteerService] Task ${taskId}: using proxy "${proxy.name}" (${proxy.host}:${proxy.port})`,
    );

    return proxy;
  }

  clearTaskProxyCursor(taskId: string) {
    this.taskProxyIndex.delete(taskId);
  }
}
