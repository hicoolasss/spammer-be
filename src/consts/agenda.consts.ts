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

// Динамические приоритеты для задач
export const TASK_PRIORITY_RANGES: Record<string, { min: number; max: number }> = {
  URGENT: { min: 15, max: 20 },    // Срочные задачи
  HIGH: { min: 8, max: 14 },        // Высокий приоритет
  NORMAL: { min: 0, max: 7 },       // Обычный приоритет
  LOW: { min: -7, max: -1 },        // Низкий приоритет
  BACKGROUND: { min: -20, max: -8 }, // Фоновые задачи
};

// Временные интервалы для рандомизации
export const TIME_RANDOMIZATION = {
  MIN_OFFSET_SECONDS: 30,  // Минимальное смещение в секундах
  MAX_OFFSET_SECONDS: 300, // Максимальное смещение в секундах (5 минут)
} as const;
