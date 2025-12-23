import { Browser, BrowserContext, Page } from 'puppeteer';

export type BrowserWrapper = {
  browser: Browser;
  context: BrowserContext;
  pages: Page[];
};
