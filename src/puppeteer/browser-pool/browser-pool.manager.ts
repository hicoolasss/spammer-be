import { CountryCode } from '@enums';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { BrowserWrapper } from '@types';
import { IS_PROD_ENV, LogWrapper } from '@utils';
import { LOCALE_SETTINGS } from '@utils';
import { getBrowserSpoofScript, getRandomItem, HEADERS, MOBILE_VIEWPORTS } from '@utils';
import * as dns from 'dns';
import { Browser, launch, Page } from 'puppeteer';
import { browserOpenTimes, pageOpenTimes } from 'src/utils/puppeteer-logging';

@Injectable()
export class BrowserPoolManager implements OnModuleDestroy {
  private readonly logger = new LogWrapper(BrowserPoolManager.name);
  private browserPool = new Map<CountryCode, BrowserWrapper[]>();
  private browserCreationLocks = new Map<CountryCode, Promise<void>>();
  private pageAcquisitionLocks = new Map<string, Promise<Page>>();

  private readonly MAX_BROWSERS_PER_GEO: number;
  private readonly MAX_TABS_PER_BROWSER: number;

  constructor() {
    this.MAX_BROWSERS_PER_GEO = Number(process.env.MAX_BROWSERS_PER_GEO) || 2;
    this.MAX_TABS_PER_BROWSER = Number(process.env.MAX_TABS_PER_BROWSER) || 10;

    this.logger.info(
      `🚀 BrowserPoolManager initialized with MAX_BROWSERS_PER_GEO=${this.MAX_BROWSERS_PER_GEO}, MAX_TABS_PER_BROWSER=${this.MAX_TABS_PER_BROWSER}`,
    );

    this.setupPeriodicCleanup();
  }

  async acquirePage(proxyGeo: CountryCode, userAgent: string): Promise<Page> {
    const localeSettings = LOCALE_SETTINGS[proxyGeo] || LOCALE_SETTINGS.ALL;
    const { locale, timeZone } = localeSettings;
    
    const lockKey = `${proxyGeo}-${userAgent}`;
    
    if (this.pageAcquisitionLocks.has(lockKey)) {
      this.logger.debug(`⏳ Waiting for page acquisition lock for ${proxyGeo}`);
      return await this.pageAcquisitionLocks.get(lockKey);
    }

    const acquisitionPromise = this.performPageAcquisition(proxyGeo, userAgent, locale, timeZone);
    this.pageAcquisitionLocks.set(lockKey, acquisitionPromise);
    
    try {
      const page = await acquisitionPromise;
      this.logger.info(`✅ Page acquired for ${proxyGeo} (userAgent: ${userAgent.substring(0, 50)}...)`);
      return page;
    } finally {
      this.pageAcquisitionLocks.delete(lockKey);
    }
  }

  private async performPageAcquisition(
    proxyGeo: CountryCode, 
    userAgent: string, 
    locale: string, 
    timeZone: string
  ): Promise<Page> {
    const activePool = this.getActiveBrowserPool(proxyGeo);
    this.logPoolDiagnostics(proxyGeo, activePool);

    const wrapper = await this.findOrCreateBrowser(proxyGeo, locale, timeZone, activePool);
    const page = await this.createPage(wrapper, userAgent, locale, timeZone, proxyGeo);
    
    this.logPoolStatusAfterAcquisition(proxyGeo, activePool);
    return page;
  }

  async releasePage(page: Page, geo: CountryCode): Promise<void> {
    const pool = this.browserPool.get(geo) || [];

    for (const wrapper of pool) {
      const idx = wrapper.pages.indexOf(page);

      if (idx === -1) continue;

      await this.closePage(page, wrapper, geo, idx);
      this.cleanupEmptyBrowsers(pool, geo);
      this.logPoolStatusAfterRelease(geo, pool);
      return;
    }
  }

  async getPoolStatistics(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};

    for (const [geo, pool] of this.browserPool.entries()) {
      const activeBrowsers = this.filterActiveBrowsers(pool);
      const activePages = activeBrowsers.flatMap(wrapper => 
        wrapper.pages.filter(page => !page.isClosed())
      );
      
      const totalTabs = activePages.length;
      const avgTabsPerBrowser = activeBrowsers.length > 0 ? Math.round(totalTabs / activeBrowsers.length) : 0;
      const utilization = activeBrowsers.length > 0
        ? Math.round((totalTabs / (activeBrowsers.length * this.MAX_TABS_PER_BROWSER)) * 100)
        : 0;

      const totalBrowsers = pool.length;
      const connectedBrowsers = activeBrowsers.length;
      const disconnectedBrowsers = totalBrowsers - connectedBrowsers;

      const browserDetails = activeBrowsers.map((wrapper, index) => {
        const activePages = wrapper.pages.filter(page => !page.isClosed());
        const closedPages = wrapper.pages.filter(page => page.isClosed());
        return {
          id: index + 1,
          connected: wrapper.browser.isConnected(),
          activeTabs: activePages.length,
          closedTabs: closedPages.length,
          totalTabs: wrapper.pages.length,
          maxTabs: this.MAX_TABS_PER_BROWSER,
          utilization: `${Math.round((activePages.length / this.MAX_TABS_PER_BROWSER) * 100)}%`,
          status: wrapper.browser.isConnected() ? '🟢 Connected' : '🔴 Disconnected',
        };
      });

      stats[geo] = {
        browsers: connectedBrowsers,
        totalBrowsers: totalBrowsers,
        disconnectedBrowsers: disconnectedBrowsers,
        maxBrowsers: this.MAX_BROWSERS_PER_GEO,
        totalTabs: totalTabs,
        maxTabs: connectedBrowsers * this.MAX_TABS_PER_BROWSER,
        avgTabsPerBrowser,
        utilization: `${utilization}%`,
        canCreateMore: connectedBrowsers < this.MAX_BROWSERS_PER_GEO,
        shouldCreateMore: avgTabsPerBrowser >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.6),
        browserDetails,
        debug: {
          poolLength: pool.length,
          activeBrowsersLength: activeBrowsers.length,
          totalActivePages: activePages.length,
          maxBrowsersPerGeo: this.MAX_BROWSERS_PER_GEO,
          maxTabsPerBrowser: this.MAX_TABS_PER_BROWSER
        }
      };
    }

    return stats;
  }

  async cleanupPoolIssues(): Promise<void> {
    this.logger.info('🧹 Starting browser pool cleanup...');

    for (const [geo, pool] of this.browserPool.entries()) {
      if (pool.length === 0) continue;

      this.removeClosedPages(pool);
      await this.closeEmptyBrowsers(pool);
      await this.createAdditionalBrowsersIfNeeded(geo, pool);
    }

    this.logger.info('✅ Browser pool cleanup completed');
  }

  async forceCleanupEmptyBrowsers(): Promise<void> {
    this.logger.info('🗑️ Force cleaning up empty browsers...');

    let totalClosed = 0;
    let totalGeosCleaned = 0;

    for (const [geo, pool] of this.browserPool.entries()) {
      if (pool.length === 0) continue;

      this.removeClosedPages(pool);
      const closedCount = await this.closeEmptyBrowsers(pool);
      totalClosed += closedCount;

      if (pool.length === 0) {
        this.browserPool.delete(geo);
        totalGeosCleaned++;
      }
    }

    this.logger.info(`✅ Cleanup completed: closed ${totalClosed} browsers, cleaned ${totalGeosCleaned} geos`);
  }

  async forceCleanupInactiveBrowsers(): Promise<void> {
    this.logger.info('🗑️ Force cleaning up inactive browsers...');
    
    let totalCleaned = 0;
    
    for (const [geo, pool] of this.browserPool.entries()) {
      const browsersToRemove: BrowserWrapper[] = [];
      
      for (const wrapper of pool) {
        if (!wrapper.browser.isConnected()) {
          browsersToRemove.push(wrapper);
          totalCleaned++;
          continue;
        }
        
        const closedPages = wrapper.pages.filter(page => page.isClosed());
        if (closedPages.length > 0) {
          wrapper.pages = wrapper.pages.filter(page => !page.isClosed());
        }
      }
      
      await this.removeBrowsersFromPool(browsersToRemove, pool, geo);
    }
    
    this.logger.info(`✅ Cleanup completed: removed ${totalCleaned} inactive browsers`);
  }

  async onModuleDestroy() {
    this.logger.info('🔄 Shutting down browser pool manager...');
    
    for (const [geo, pool] of this.browserPool.entries()) {
      this.logger.info(`🔄 Closing ${pool.length} browsers for ${geo}`);
      
      for (const wrapper of pool) {
        for (const p of wrapper.pages) {
          try {
            await p.close();
          } catch (error) {
            this.logger.warn(`Failed to close page: ${error.message}`);
          }
        }
        try {
          await wrapper.context.close();
        } catch (error) {
          this.logger.warn(`Failed to close context: ${error.message}`);
        }
        try {
          await wrapper.browser.close();
        } catch (error) {
          this.logger.warn(`Failed to close browser: ${error.message}`);
        }
      }
    }
    
    this.browserPool.clear();
    this.logger.info('✅ Browser pool manager shutdown completed');
  }

  private setupPeriodicCleanup(): void {
    setInterval(
      async () => {
        try {
          await this.cleanupPoolIssues();
        } catch (error) {
          this.logger.error(`Error during periodic cleanup: ${error.message}`);
        }
      },
      5 * 60 * 1000,
    );
  }

  private getActiveBrowserPool(proxyGeo: CountryCode): BrowserWrapper[] {
    const pool = this.browserPool.get(proxyGeo) || [];
    
    const activeBrowsers = pool.filter((w) => {
      if (!w.browser.isConnected()) {
        this.logger.warn(`Found disconnected browser for ${proxyGeo}, removing from pool`);
        return false;
      }
      
      const originalPagesCount = w.pages.length;
      w.pages = w.pages.filter((page) => !page.isClosed());
      const closedPagesCount = originalPagesCount - w.pages.length;
      
      if (closedPagesCount > 0) {
        this.logger.debug(`Removed ${closedPagesCount} closed pages from browser`);
      }
      
      return w.pages.length > 0 || w.browser.isConnected();
    });

    this.browserPool.set(proxyGeo, activeBrowsers);
    return activeBrowsers;
  }

  private logPoolDiagnostics(proxyGeo: CountryCode, activePool: BrowserWrapper[]): void {
    const totalTabs = activePool.reduce((sum, w) => {
      const activePages = w.pages.filter(page => !page.isClosed());
      return sum + activePages.length;
    }, 0);
    
    const avgTabsPerBrowser = activePool.length > 0 ? Math.round(totalTabs / activePool.length) : 0;
    
    this.logger.info(
      `📊 Pool diagnostics for ${proxyGeo}: browsers=${activePool.length}, total tabs=${totalTabs}, average=${avgTabsPerBrowser}/browser`,
    );

    activePool.forEach((browser, index) => {
      const activePages = browser.pages.filter(page => !page.isClosed());
      this.logger.debug(
        `Browser #${index + 1}: connected=${browser.browser.isConnected()}, tabs=${activePages.length}/${this.MAX_TABS_PER_BROWSER}`,
      );
    });
  }

  private async findOrCreateBrowser(
    proxyGeo: CountryCode, 
    locale: string, 
    timeZone: string, 
    activePool: BrowserWrapper[]
  ): Promise<BrowserWrapper> {
    const shouldCreateNewBrowser = this.shouldCreateNewBrowser(activePool);
    
    const wrapper = this.findBrowserWithFreeSlots(activePool);
    if (wrapper) {
      return wrapper;
    }

    if (shouldCreateNewBrowser && activePool.length < this.MAX_BROWSERS_PER_GEO) {
      return await this.createNewBrowser(proxyGeo, locale, timeZone);
    }

    return this.findAnyAvailableBrowser(activePool);
  }

  private shouldCreateNewBrowser(activePool: BrowserWrapper[]): boolean {
    if (activePool.length === 0) return true;
    
    if (activePool.every((w) => {
      const activePages = w.pages.filter(page => !page.isClosed());
      return activePages.length >= this.MAX_TABS_PER_BROWSER;
    })) return true;
    
    if (activePool.length === 1 && this.getTotalActiveTabs(activePool) >= this.MAX_TABS_PER_BROWSER * 0.8) return true;
    
    if (activePool.length === 2 && activePool.every((w) => {
      const activePages = w.pages.filter(page => !page.isClosed());
      return activePages.length >= this.MAX_TABS_PER_BROWSER * 0.9;
    })) return true;
    
    return false;
  }

  private findBrowserWithFreeSlots(activePool: BrowserWrapper[]): BrowserWrapper | null {
    const sortedBrowsers = activePool
      .filter((w) => {
        const activePages = w.pages.filter(page => !page.isClosed());
        return activePages.length < this.MAX_TABS_PER_BROWSER;
      })
      .sort((a, b) => {
        const aActivePages = a.pages.filter(page => !page.isClosed());
        const bActivePages = b.pages.filter(page => !page.isClosed());
        return aActivePages.length - bActivePages.length;
      });
    
    return sortedBrowsers[0] || null;
  }

  private async createNewBrowser(
    proxyGeo: CountryCode, 
    locale: string, 
    timeZone: string
  ): Promise<BrowserWrapper> {
    this.logger.info(`🆕 Creating new browser for ${proxyGeo}`);
    
    if (!this.browserCreationLocks.has(proxyGeo)) {
      const lockPromise = new Promise<void>((resolve) => {
        setTimeout(() => resolve(), Math.random() * 500 + 200);
      });
      this.browserCreationLocks.set(proxyGeo, lockPromise);

      try {
        const newWrapper = await this.createBrowserWrapper(locale, timeZone);
        const pool = this.browserPool.get(proxyGeo) || [];
        pool.push(newWrapper);
        this.browserPool.set(proxyGeo, pool);
        this.logger.info(`✅ New browser created for ${proxyGeo}`);
        return newWrapper;
      } finally {
        this.browserCreationLocks.delete(proxyGeo);
      }
    } else {
      this.logger.debug(`⏳ Waiting for browser creation lock for ${proxyGeo}`);
      await this.browserCreationLocks.get(proxyGeo);
      const updatedPool = this.browserPool.get(proxyGeo) || [];
      return this.findBrowserWithFreeSlots(updatedPool) || updatedPool[0];
    }
  }

  private findAnyAvailableBrowser(activePool: BrowserWrapper[]): BrowserWrapper {
    if (activePool.length === 0) {
      throw new Error('No browsers available');
    }
    
    return activePool.reduce((min, w) => {
      const minActivePages = min.pages.filter(page => !page.isClosed());
      const wActivePages = w.pages.filter(page => !page.isClosed());
      return wActivePages.length < minActivePages.length ? w : min;
    }, activePool[0]);
  }

  private async createPage(
    wrapper: BrowserWrapper,
    userAgent: string,
    locale: string,
    timeZone: string,
    proxyGeo: CountryCode,
  ): Promise<Page> {
    if (wrapper.pages.length >= this.MAX_TABS_PER_BROWSER) {
      throw new Error('MAX_TABS limit reached for this browser');
    }

    const page = await wrapper.context.newPage();
    const pageOpenTime = Date.now();
    pageOpenTimes.set(page, pageOpenTime);
    wrapper.pages.push(page);

    page.on('close', () => {
      pageOpenTimes.delete(page);
    });

    await this.setupPage(page, userAgent, locale, timeZone, proxyGeo);
    return page;
  }

  private async setupPage(
    page: Page,
    userAgent: string,
    locale: string,
    timeZone: string,
    proxyGeo: CountryCode,
  ): Promise<void> {
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
    page.on('request', async (req) => req.continue());
    this.setupPageErrorHandlers(page, proxyGeo);
  }

  private setupPageErrorHandlers(page: Page, proxyGeo: CountryCode): void {
    page.on('error', (err) => {
      if (this.handleChromePropertyError(err, `Page error [${proxyGeo}]`)) return;
    });

    page.on('pageerror', (err) => {
      if (this.handleChromePropertyError(err, `Runtime error [${proxyGeo}]`)) return;
      this.logger.warn(`Runtime error [${proxyGeo}]: ${err.message}`);
    });
  }

  private async closePage(page: Page, wrapper: BrowserWrapper, geo: CountryCode, idx: number): Promise<void> {
    const pageOpenTime = pageOpenTimes.get(page);
    const pageAge = pageOpenTime ? Date.now() - pageOpenTime : 'unknown';
    
    this.logger.debug(`Closing page, age: ${pageAge}ms, total pages in browser: ${wrapper.pages.length}`);

    wrapper.pages.splice(idx, 1);
    pageOpenTimes.delete(page);

    await page.setRequestInterception(false).catch(() => {});
    page.removeAllListeners('request');
    await page.close().catch(() => {});

    this.logger.debug(`Page closed, remaining pages: ${wrapper.pages.length}`);
  }

  private cleanupEmptyBrowsers(pool: BrowserWrapper[], geo: CountryCode): void {
    if (pool.length === 0) return;

    const emptyBrowsers = pool.filter((w) => w.pages.length === 0);
    if (emptyBrowsers.length > 0) {
      this.logger.info(`Found ${emptyBrowsers.length} empty browsers, closing them`);
      
      for (const emptyBrowser of emptyBrowsers) {
        this.closeBrowser(emptyBrowser);
      }
      
      const index = pool.indexOf(emptyBrowsers[0]);
      if (index > -1) {
        pool.splice(index, 1);
      }
    }

    if (pool.length === 0) {
      this.browserPool.delete(geo);
    }
  }

  private async closeBrowser(wrapper: BrowserWrapper): Promise<void> {
    try {
      await wrapper.context.close().catch(() => {});
      await wrapper.browser.close().catch(() => {});
    } catch (error) {
      this.logger.error(`Error closing browser: ${error.message}`);
    }
  }

  private removeClosedPages(pool: BrowserWrapper[]): void {
    for (const wrapper of pool) {
      wrapper.pages = wrapper.pages.filter((page) => !page.isClosed());
    }
  }

  private async closeEmptyBrowsers(pool: BrowserWrapper[]): Promise<number> {
    const browsersToRemove: BrowserWrapper[] = [];
    let closedCount = 0;
    
    for (const wrapper of pool) {
      if (wrapper.pages.length === 0) {
        browsersToRemove.push(wrapper);
        closedCount++;
      }
    }

    for (const wrapper of browsersToRemove) {
      await this.closeBrowser(wrapper);
      const index = pool.indexOf(wrapper);
      if (index > -1) {
        pool.splice(index, 1);
      }
    }

    return closedCount;
  }

  private async createAdditionalBrowsersIfNeeded(geo: CountryCode, pool: BrowserWrapper[]): Promise<void> {
    const totalTabs = pool.reduce((sum, w) => sum + w.pages.length, 0);
    const avgTabsPerBrowser = Math.round(totalTabs / pool.length);

    if (
      pool.length < this.MAX_BROWSERS_PER_GEO &&
      avgTabsPerBrowser >= Math.floor(this.MAX_TABS_PER_BROWSER * 0.8)
    ) {
      this.logger.info(`Creating additional browser (average tabs: ${avgTabsPerBrowser})`);
      try {
        const localeSettings = LOCALE_SETTINGS[geo] || LOCALE_SETTINGS.ALL;
        const { locale, timeZone } = localeSettings;
        const newWrapper = await this.createBrowserWrapper(locale, timeZone);
        pool.push(newWrapper);
        this.logger.info(`✅ Additional browser created`);
      } catch (error) {
        this.logger.error(`Error creating additional browser: ${error.message}`);
      }
    }
  }

  private async removeBrowsersFromPool(
    browsersToRemove: BrowserWrapper[], 
    pool: BrowserWrapper[], 
    geo: CountryCode
  ): Promise<void> {
    for (const wrapper of browsersToRemove) {
      await this.closeBrowser(wrapper);
      const index = pool.indexOf(wrapper);
      if (index > -1) {
        pool.splice(index, 1);
      }
    }
    
    if (pool.length === 0) {
      this.browserPool.delete(geo);
    }
  }

  private async createBrowserWrapper(locale: string, timeZone: string): Promise<BrowserWrapper> {
    const browser = await this.createBrowser(locale, timeZone);
    const context = await browser.createBrowserContext();

    context.on('error', (err: Error) => {
      if (this.handleChromePropertyError(err, 'Context error')) return;
    });

    return { browser, context, pages: [] };
  }

  private async createBrowser(locale: string, timeZone: string): Promise<Browser> {
    dns.setServers(['1.1.1.1']);
    
    const browser = await launch({
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

    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
    } catch {
      // Ignore
    }

    browserOpenTimes.set(browser, Date.now());
    browser.on('disconnected', () => {
      this.logger.warn('Browser disconnected, clearing all pools');
      this.browserPool.clear();
    });

    browser.on('error', (err: Error) => {
      if (this.handleChromePropertyError(err, 'Browser error')) return;
    });

    return browser;
  }

  private sanitizeModuleScript(script: string): string {
    return script.replace(/^\s*(export|import)\s.*$/gm, '');
  }

  private handleChromePropertyError(err: Error, context: string): boolean {
    const handledErrors = [
      'Cannot redefine property: chrome',
      'Cannot redefine property',
      'Unexpected token',
      'SyntaxError',
      'Unexpected identifier',
      'Unexpected end of input',
      'Invalid or unexpected token',
      'Failed to fetch',
      'TypeError',
      'Cannot read properties of undefined',
      'prototype',
      'masterstroke_ajax is not defined',
      'wp is not defined',
      'i18n',
      'hooks',
      'ReferenceError',
      'vkCreateInstance',
      'VK_ERROR_INCOMPATIBLE_DRIVER',
      'eglChooseConfig',
      'BackendType::OpenGLES',
      'Bind context provider failed',
      'handshake failed',
      'SSL error code',
      'video_capture_service_impl'
    ];

    for (const errorPattern of handledErrors) {
      if (err.message.includes(errorPattern)) {
        return true;
      }
    }

    this.logger.error(`${context} error: ${err}`);
    return false;
  }

  private filterActiveBrowsers(pool: BrowserWrapper[]): BrowserWrapper[] {
    return pool.filter(wrapper => {
      if (!wrapper.browser.isConnected()) {
        return false;
      }
      wrapper.pages = wrapper.pages.filter(page => !page.isClosed());
      return true;
    });
  }

  private getTotalActiveTabs(activePool: BrowserWrapper[]): number {
    return activePool.reduce((sum, w) => {
      const activePages = w.pages.filter(page => !page.isClosed());
      return sum + activePages.length;
    }, 0);
  }

  private logPoolStatusAfterAcquisition(proxyGeo: CountryCode, activePool: BrowserWrapper[]): void {
    const totalTabsAfter = activePool.reduce((sum, w) => {
      const activePages = w.pages.filter(page => !page.isClosed());
      return sum + activePages.length;
    }, 0);
    
    const avgTabsPerBrowserAfter = activePool.length > 0 ? Math.round(totalTabsAfter / activePool.length) : 0;
    
    this.logger.info(
      `📊 Pool status after acquisition for ${proxyGeo}: ` +
      `browsers=${activePool.length}, total tabs=${totalTabsAfter}, average=${avgTabsPerBrowserAfter}/browser`,
    );
  }

  private logPoolStatusAfterRelease(geo: CountryCode, pool: BrowserWrapper[]): void {
    const totalTabsAfter = pool.reduce((sum, w) => {
      const activePages = w.pages.filter(page => !page.isClosed());
      return sum + activePages.length;
    }, 0);
    
    const avgTabsPerBrowserAfter = pool.length > 0 ? Math.round(totalTabsAfter / pool.length) : 0;
    
    this.logger.info(
      `📊 Pool status after release for ${geo}: ` +
      `browsers=${pool.length}, total tabs=${totalTabsAfter}, average=${avgTabsPerBrowserAfter}/browser`,
    );
  }
} 