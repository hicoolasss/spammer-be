import { CountryCode } from '@enums';
import { BrowserWrapper } from '@types';
import Table from 'cli-table3';
import { Browser, Page } from 'puppeteer';

import { LogWrapper } from './LogWrapper';

export const browserOpenTimes = new WeakMap<Browser, number>();
export const pageOpenTimes = new WeakMap<Page, number>();

const logger = new LogWrapper('PuppeteerLogging');

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function logAllGeoPoolsTable(browserPool: Map<CountryCode, BrowserWrapper[]>) {
  const now = Date.now();
  for (const [geo, pool] of browserPool.entries()) {
    if (pool.length === 0) {
      logger.info(`\n[geo=${geo}] No browsers in pool`);
      continue;
    }

    const maxTabs = Math.max(0, ...pool.map((w) => w.pages.length));
    const tabHeaders = Array.from({ length: maxTabs }, (_, i) => `Tab #${i + 1}`);
    const table = new Table({
      head: ['Browser #', 'Tabs', 'Browser Age', 'Status', ...tabHeaders],
      style: { head: ['cyan'] },
      wordWrap: true,
    });

    pool.forEach((w, i) => {
      const browserTime = browserOpenTimes.get(w.browser);
      const browserAge = browserTime ? formatDuration(now - browserTime) : '?';

      const browserStatus = w.browser.isConnected() ? '🟢' : '🔴';

      const tabAges = w.pages.map((p) => {
        const t = pageOpenTimes.get(p);
        if (!t) {
          return '❓';
        }
        const age = formatDuration(now - t);
        return p.isClosed() ? `❌(${age})` : age;
      });

      const rowTabs = tabAges.slice(0, maxTabs);
      while (rowTabs.length < tabHeaders.length) rowTabs.push('-');

      table.push([`#${i + 1}`, w.pages.length, browserAge, browserStatus, ...rowTabs]);
    });

    logger.info(
      `[geo=${geo}] Browsers: ${pool.length}, Total tabs: ${pool.reduce((sum, w) => sum + w.pages.length, 0)}`,
    );
    logger.info('\n', table.toString());
  }
}
