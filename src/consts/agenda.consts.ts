export const JOB_TASK_PROCESSOR = 'JOB: process random task';

export const CRON_TASK_PROCESSOR = '* * * * *';
export const FIVE_MIN = 1000 * 60 * 5;

export enum JobPriority {
  highest = 20,
  high = 10,
  normal = 0,
  low = -10,
  lowest = -20,
}
