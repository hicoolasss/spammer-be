import { LogWrapper } from './LogWrapper';

const logger = new LogWrapper('ConcurrencyLimits');

export function calculateMaxConcurrentTasks(): number {
  const maxBrowsersPerGeo = Number(process.env.MAX_BROWSERS_PER_GEO) || 10;
  const maxTabsPerBrowser = Number(process.env.MAX_TABS_PER_BROWSER) || 10;
  const maxConcurrency = Number(process.env.BULLMQ_CONCURRENCY) || 50;

  const maxTabs = maxBrowsersPerGeo * maxTabsPerBrowser;
  const calculatedLimit = Math.min(maxTabs, maxConcurrency);

  logger.info(
    `Calculated MAX_CONCURRENT_TASKS: ${calculatedLimit} ` +
      `(browsers: ${maxBrowsersPerGeo}, tabs per browser: ${maxTabsPerBrowser}, ` +
      `max tabs: ${maxTabs}, requested concurrency: ${maxConcurrency})`,
  );

  return calculatedLimit;
}

export function getBrowserLimits() {
  const maxBrowsersPerGeo = Number(process.env.MAX_BROWSERS_PER_GEO) || 10;
  const maxTabsPerBrowser = Number(process.env.MAX_TABS_PER_BROWSER) || 10;
  const maxTabs = maxBrowsersPerGeo * maxTabsPerBrowser;

  return {
    maxBrowsersPerGeo,
    maxTabsPerBrowser,
    maxTabs,
    maxConcurrentTasks: calculateMaxConcurrentTasks(),
  };
}
