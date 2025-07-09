import { float } from "aws-sdk/clients/cloudfront";
import { Page } from "puppeteer";

export interface MobileViewport {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch?: boolean;
  screenSize?: float;
  densityPPI?: number;
}

export interface ArchiveContext {
  page: Page;
  linkUrl: string;
  locale: string;
  userAgent: string;
}
