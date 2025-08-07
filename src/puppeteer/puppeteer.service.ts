import { CountryCode } from '@enums';
import { Injectable } from '@nestjs/common';
import { LogWrapper } from '@utils';
import { Page } from 'puppeteer';

import { BrowserPoolManager } from './browser-pool/browser-pool.manager';

@Injectable()
export class PuppeteerService {
  private readonly logger = new LogWrapper(PuppeteerService.name);

  constructor(private readonly browserPoolManager: BrowserPoolManager) {}

  async acquirePage(proxyGeo: CountryCode, userAgent: string): Promise<Page> {
    return await this.browserPoolManager.acquirePage(proxyGeo, userAgent);
  }

  async releasePage(page: Page, geo: CountryCode): Promise<void> {
    return await this.browserPoolManager.releasePage(page, geo);
  }

  async getPoolStatistics(): Promise<Record<string, any>> {
    return await this.browserPoolManager.getPoolStatistics();
  }

  async getDetailedPoolInfo(): Promise<Record<string, any>> {
    const stats = await this.browserPoolManager.getPoolStatistics();
    const detailedInfo: Record<string, any> = {};

    for (const [geo, geoStats] of Object.entries(stats)) {
      detailedInfo[geo] = {
        browsers: geoStats.browserDetails || [],
        summary: {
          totalBrowsers: geoStats.totalBrowsers,
          connectedBrowsers: geoStats.browsers,
          disconnectedBrowsers: geoStats.disconnectedBrowsers,
          totalTabs: geoStats.totalTabs,
          activeTabs: geoStats.totalTabs,
          closedTabs: 0, // This would need to be calculated from browser details
          avgTabsPerBrowser: geoStats.avgTabsPerBrowser,
        },
      };
    }

    return detailedInfo;
  }

  async diagnosePoolIssues(): Promise<void> {
    this.logger.info('🔍 Diagnosing browser pools...');
    const stats = await this.browserPoolManager.getPoolStatistics();

    for (const [geo, geoStats] of Object.entries(stats)) {
      this.logger.info(`📊 ${geo}:`);
      this.logger.info(`  - Browsers: ${geoStats.browsers}/${geoStats.maxBrowsers}`);
      this.logger.info(`  - Tabs: ${geoStats.totalTabs}/${geoStats.maxTabs}`);
      this.logger.info(`  - Average tabs per browser: ${geoStats.avgTabsPerBrowser}`);
      this.logger.info(`  - Utilization: ${geoStats.utilization}`);

      if (geoStats.shouldCreateMore) {
        this.logger.info(`⚠️ ${geo}: Average tabs ${geoStats.avgTabsPerBrowser} >= 60%, recommend creating new browser`);
      }
    }
  }

  async forceCreateBrowsers(geo: CountryCode, count: number = 1): Promise<void> {
    this.logger.info(`🚀 Force creating ${count} browsers for ${geo}`);
    
    // This would need to be implemented in BrowserPoolManager
    // For now, we'll just log the request
    this.logger.warn('Force browser creation not yet implemented in new architecture');
  }

  async cleanupPoolIssues(): Promise<void> {
    return await this.browserPoolManager.cleanupPoolIssues();
  }

  async forceCleanupEmptyBrowsers(): Promise<void> {
    return await this.browserPoolManager.forceCleanupEmptyBrowsers();
  }

  async forceReleasePagesForGeo(geo: CountryCode): Promise<void> {
    this.logger.info(`🗑️ Force releasing pages for ${geo}`);
    
    // This would need to be implemented in BrowserPoolManager
    // For now, we'll just log the request
    this.logger.warn('Force page release not yet implemented in new architecture');
  }

  async forceCleanupInactiveBrowsers(): Promise<void> {
    return await this.browserPoolManager.forceCleanupInactiveBrowsers();
  }
}
