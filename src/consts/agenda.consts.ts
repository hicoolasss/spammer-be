export const JOB_CLEANUP_OLD_JOBS = 'JOB: cleanupOldJobs';

export const CRON_CLEANUP_OLD_JOBS = '0 * * * *';
export const FIVE_MIN = 1_000 * 60 * 5;

export enum JobPriority {
  highest = 20,
  high = 10,
  normal = 0,
  low = -10,
  lowest = -20,
}
