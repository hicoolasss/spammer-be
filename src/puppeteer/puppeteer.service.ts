import { CountryCode } from '@enums';
import { Injectable, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { BROWSER_ARGUMENTS, IS_PROD_ENV, LogWrapper } from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import { getBrowserSpoofScript, getRandomItem, HEADERS, MOBILE_VIEWPORTS } from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';
import { CaptchaService } from 'src/captcha/captcha-solver.service';
import { ProxyConfig } from 'src/types/proxy.types';
import { CAPTCHA_PROXY_USERNAMES, isSpamspamUser } from 'src/utils/captcha-proxies';
import { browserOpenTimes } from 'src/utils/puppeteer-logging';

type ProxyMode = 'normal' | 'captcha';

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

const CAPTCHA_PROXY_HOST = process.env.CAPTCHA_PROXY_HOST ?? '';
const CAPTCHA_PROXY_PORT = Number(process.env.CAPTCHA_PROXY_PORT ?? '');
const CAPTCHA_PROXY_PASSWORD_DEFAULT = process.env.CAPTCHA_PROXY_PASSWORD_DEFAULT ?? '';
const CAPTCHA_PROXY_PASSWORD_SPAMSPAM = process.env.CAPTCHA_PROXY_PASSWORD_SPAMSPAM ?? '';

const getCaptchaPassword = (username: string) => {
  return isSpamspamUser(username)
    ? CAPTCHA_PROXY_PASSWORD_SPAMSPAM
    : CAPTCHA_PROXY_PASSWORD_DEFAULT;
};

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
    options?: {
      linkurl?: string;
      isCaptcha?: boolean;
    },
  ): Promise<{ browser: Browser; page: Page }> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
  
    const isCaptcha = options?.isCaptcha === true;
    const proxyMode: ProxyMode = isCaptcha ? 'captcha' : 'normal';

    const proxy = this.getNextProxy(taskId, proxyGeo, proxyMode);
  
    const browser = await this.createBrowser(locale, timeZone, proxy, {
      isCaptcha,
    });
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

    if (!isCaptcha) {
      await page.setExtraHTTPHeaders(
        HEADERS(locale, userAgent, options?.linkurl),
      );
    
      this.logger.debug?.(
        `[PuppeteerService] Extra headers applied (isCaptcha=false)`,
      );
    } else {
      this.logger.info(
        `[PuppeteerService] Skipping extra headers (isCaptcha=true)`,
      );
    }
    
    await page.emulateTimezone(timeZone);
  
    const localeRaw = getBrowserSpoofScript(locale, timeZone);
    const localeScript = this.sanitizeModuleScript(localeRaw);
    await page.evaluateOnNewDocument(`(()=>{${localeScript}})();`);

    if (isCaptcha) {
      const turnstileScript = this.captchaService.getTurnstileInjectScript();
      await page.evaluateOnNewDocument(turnstileScript);
    
      this.logger.info(
        `[PuppeteerService] Turnstile inject script enabled (isCaptcha=true)`,
      );
    } else {
      this.logger.debug?.(
        `[PuppeteerService] Turnstile inject skipped (isCaptcha=false)`,
      );
    }
  
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
    options?: {
      isCaptcha?: boolean;
    },
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
        args: BROWSER_ARGUMENTS(proxyArg, locale, timeZone, {
          disableWebSecurity: !(options?.isCaptcha === true),
        }),
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

  private cursorKey(taskId: string, mode: ProxyMode) {
    return `${taskId}:${mode}`;
  }

  private getNextProxy(taskId: string, geo: CountryCode, mode: ProxyMode): ProxyConfig {
    geo = this.normalizeGeo(geo);

    const key = this.cursorKey(taskId, mode);
    const idx = this.taskProxyIndex.get(key) ?? 0;

    if (mode === 'normal') {
      if (PROVIDERS.length === 0) throw new Error('No proxy providers configured');

      const provider = PROVIDERS[idx % PROVIDERS.length];
      this.taskProxyIndex.set(key, idx + 1);

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

      this.logger.debug(`[Proxy] Task ${taskId}: mode=normal -> "${proxy.name}" (${proxy.host}:${proxy.port})`);
      return proxy;
    }

    const g = String(geo).toUpperCase();
    const list = CAPTCHA_PROXY_USERNAMES[g] ?? CAPTCHA_PROXY_USERNAMES['CZ'];
    if (!list?.length) {
      throw new Error(`No captcha usernames configured for geo=${g}`);
    }

    const username = list[idx % list.length];
    const password = getCaptchaPassword(username);

    if (isSpamspamUser(username) && !CAPTCHA_PROXY_PASSWORD_SPAMSPAM) {
      throw new Error('CAPTCHA_PROXY_PASSWORD_SPAMSPAM is empty (required for spamspam users)');
    }
    if (!isSpamspamUser(username) && !CAPTCHA_PROXY_PASSWORD_DEFAULT) {
      throw new Error('CAPTCHA_PROXY_PASSWORD_DEFAULT is empty');
    }

    this.taskProxyIndex.set(key, idx + 1);

    const proxy: ProxyConfig = {
      name: `CH-${g}-${idx % list.length}`,
      host: CAPTCHA_PROXY_HOST,
      port: CAPTCHA_PROXY_PORT,
      username,
      password,
    };

    if (!proxy.host || !Number.isFinite(proxy.port) || !proxy.username || !proxy.password) {
      throw new Error(`Captcha proxy is not fully configured (check env vars/passwords)`);
    }

    this.logger.debug(`[Proxy] Task ${taskId}: mode=captcha -> "${proxy.name}" (${proxy.host}:${proxy.port})`);
    return proxy;
  }

  clearTaskProxyCursor(taskId: string) {
    this.taskProxyIndex.delete(this.cursorKey(taskId, 'normal'));
    this.taskProxyIndex.delete(this.cursorKey(taskId, 'captcha'));
  }
}
