import { Browser, BrowserContext, Page } from 'puppeteer';

export type BrowserWrapper = {
  browser: Browser;
  context: BrowserContext;
  pages: Page[];
  reservedTabs: number; // Количество зарезервированных вкладок (ожидают открытия или уже открыты)
};
