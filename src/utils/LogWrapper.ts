import { Logger } from '@nestjs/common';

type LogType = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export class LogWrapper {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  async log(type: LogType, message: string, ...meta: unknown[]) {
    if (typeof this.logger[type] === 'function') {
      this.logger[type](message, ...meta);
    } else {
      this.logger.log(message, ...meta);
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
