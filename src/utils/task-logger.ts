import { LogWrapper } from './LogWrapper';

export class TaskLogger {
  private readonly logger: LogWrapper;
  private readonly taskId: string;

  constructor(className: string, taskId: string) {
    this.logger = new LogWrapper(className);
    this.taskId = taskId;
  }

  private formatMessage(message: string): string {
    return `[TASK_${this.taskId}] ${message}`;
  }

  info(message: string): void {
    this.logger.log('log', this.formatMessage(message)).catch(() => {});
  }

  debug(message: string): void {
    this.logger.log('debug', this.formatMessage(message)).catch(() => {});
  }

  warn(message: string): void {
    this.logger.log('warn', this.formatMessage(message)).catch(() => {});
  }

  error(message: string): void {
    this.logger.log('error', this.formatMessage(message)).catch(() => {});
  }

  log(message: string): void {
    this.logger.log('log', this.formatMessage(message)).catch(() => {});
  }
} 