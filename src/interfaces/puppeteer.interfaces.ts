import { float } from "aws-sdk/clients/cloudfront";

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
