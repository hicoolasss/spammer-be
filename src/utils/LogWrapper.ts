import { Logger } from '@nestjs/common';

import { IS_PROD_ENV } from './env.enums';
import logtail from './logtail';

type LogType = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export class LogWrapper {
  private readonly logger: Logger;
  private readonly useLogtail: boolean;

  constructor(context: string, useLogtail = true) {
    this.logger = new Logger(context);
    this.useLogtail = useLogtail;
  }

  async log(type: LogType, message: string, ...meta: unknown[]) {
    if (typeof this.logger[type] === 'function') {
      this.logger[type](message, ...meta);
    } else {
      this.logger.log(message, ...meta);
    }

    if (IS_PROD_ENV && this.useLogtail && logtail[type]) {
      try {
        logtail[type](message, ...meta);
        await logtail.flush();
      } catch (error) {
        this.logger.error('Logtail logging failed', error);
      }
    }
  }

  async error(message: string, ...meta: unknown[]) {
    await this.log('error', message, ...meta);
  }

  async warn(message: string, ...meta: unknown[]) {
    await this.log('warn', message, ...meta);
  }

  async info(message: string, ...meta: unknown[]) {
    await this.log('log', message, ...meta);
  }

  async debug(message: string, ...meta: unknown[]) {
    await this.log('debug', message, ...meta);
  }

  async verbose(message: string, ...meta: unknown[]) {
    await this.log('verbose', message, ...meta);
  }
}
