import { CountryCode } from '@enums';
import { Injectable, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { BROWSER_ARGUMENTS, IS_PROD_ENV, LogWrapper } from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import { getBrowserSpoofScript, getRandomItem, HEADERS, MOBILE_VIEWPORTS } from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';
import { CaptchaService } from 'src/captcha/captcha-solver.service';
import { ProxyConfig } from 'src/types/proxy.types';
import { browserOpenTimes } from 'src/utils/puppeteer-logging';

type ProxyProvider = {
  name: string;
  host: string;
  port: number;
  build: (geo: CountryCode) => { username: string; password: string };
};

const parseSupportedGeos = (): Set<string> => {
  const raw = process.env.SUPPORTED_PROXY_GEOS?.trim();
  if (!raw) return new Set(['CZ', 'SK', 'DE', 'RO']);
  return new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
};

const SUPPORTED_GEOS = parseSupportedGeos();

const PROVIDERS: ProxyProvider[] = [
  {
    name: 'PacketStream',
    host: process.env.PS_PROXY_HOST ?? '',
    port: Number(process.env.PS_PROXY_PORT ?? ''),
    build: (geo) => {
      const tpl = process.env.PS_PROXY_PASSWORD_TEMPLATE ?? '';
      return {
        username: process.env.PS_PROXY_USERNAME ?? '',
        password: tpl.replace('{GEO}', String(geo)),
      };
    },
  },
  {
    name: 'PIA',
    host: process.env.PIA_PROXY_HOST ?? '',
    port: Number(process.env.PIA_PROXY_PORT ?? ''),
    build: (geo) => {
      const tpl = process.env.PIA_PROXY_USERNAME_TEMPLATE ?? '';
      return {
        username: tpl.replace('{geo}', String(geo).toLowerCase()),
        password: process.env.PIA_PROXY_PASSWORD ?? '',
      };
    },
  },
];

@Injectable()
export class PuppeteerService implements OnModuleDestroy {
  private readonly logger = new LogWrapper(PuppeteerService.name);

  constructor(private readonly captchaService: CaptchaService) {}

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
    for (const [i, p] of PROVIDERS.entries()) {
      if (!p.host || !Number.isFinite(p.port) || p.port <= 0) {
        this.logger.error(`[PuppeteerService] Provider #${i} (${p.name}) host/port invalid`);
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
  
    const proxy = this.getNextProxy(taskId, proxyGeo);
  
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

    const turnstileScript = this.captchaService.getTurnstileInjectScript();
    await page.evaluateOnNewDocument(turnstileScript);
  
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

  private normalizeGeo(geo: CountryCode): CountryCode {
    const g = String(geo).toUpperCase();
    if (!SUPPORTED_GEOS.has(g)) {
      this.logger.warn(`[Proxy] Unsupported geo="${geo}", fallback to CZ`);
      return CountryCode.CZ;
    }
    return geo;
  }

  private getNextProxy(taskId: string, geo: CountryCode): ProxyConfig {
    if (PROVIDERS.length === 0) throw new Error('No proxy providers configured');

    geo = this.normalizeGeo(geo);

    const idx = this.taskProxyIndex.get(taskId) ?? 0;
    const provider = PROVIDERS[idx % PROVIDERS.length];
    this.taskProxyIndex.set(taskId, idx + 1);

    const { username, password } = provider.build(geo);

    const proxy: ProxyConfig = {
      name: `${provider.name}-${geo}`,
      host: provider.host,
      port: provider.port,
      username,
      password,
    };

    if (!proxy.host || !Number.isFinite(proxy.port) || !proxy.username || !proxy.password) {
      throw new Error(`Proxy "${proxy.name}" is not fully configured (check env templates)`);
    }

    this.logger.debug(
      `[PuppeteerService] Task ${taskId}: using proxy "${proxy.name}" (${proxy.host}:${proxy.port})`,
    );

    return proxy;
  }

  clearTaskProxyCursor(taskId: string) {
    this.taskProxyIndex.delete(taskId);
  }
}
