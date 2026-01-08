import { LogWrapper } from './LogWrapper';

const logger = new LogWrapper('ConcurrencyLimits');

export function getMaxConcurrentTasks(): number {
  const v = Number(process.env.MAX_CONCURRENT_TASKS);
  const result = Number.isFinite(v) && v > 0 ? Math.floor(v) : 4;

  logger.info(`[Concurrency] MAX_CONCURRENT_TASKS = ${result}`);

  return result;
}
