import { 
  CRON_CLEANUP_OLD_JOBS, 
  FIVE_MIN, 
  JOB_CLEANUP_OLD_JOBS, 
  JobPriority,
  TASK_PRIORITY_RANGES,
  TIME_RANDOMIZATION
} from '@consts';
import { TaskStatus } from '@enums';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task, TaskDocument } from '@task/task.schema';
import { JobWrapper, LogWrapper } from '@utils';
import { Job } from 'agenda';
import { Model } from 'mongoose';

import agenda from './agendaInstance';
import { TaskProcessorService } from './task-processor.service';

@Injectable()
export class AgendaService implements OnModuleInit {
  private readonly logger = new LogWrapper(AgendaService.name);
  private readonly TASK_LOCK_LIFETIME = 15 * 60 * 1000; // 15 минут вместо 5

  constructor(
    private readonly taskProcessorService: TaskProcessorService,
    @InjectModel(Task.name) private readonly taskModel: Model<Task>,
  ) {}

  async onModuleInit() {
    try {
      await this.resetAllTaskLocks();
      await this.resetLockedAgendaJobs();
      await this.cleanupOldJobs();
      await agenda.start();
      this.logger.info('Agenda started successfully');

      agenda.define(
        'runTask',
        {
          lockLifetime: this.TASK_LOCK_LIFETIME,
        },
        this.wrapJob('runTask', async (job: Job) => {
          this.logger.info(`Running task job: ${job.attrs.data.taskId}`);

          const { taskId } = job.attrs.data as { taskId: string };
          if (!taskId) {
            this.logger.error('runTask job: taskId is missing in job data');
            return;
          }

          const task = await this.taskModel.findById(taskId);
          if (!task) {
            this.logger.warn(`Task ${taskId} not found, skipping job`);
            return;
          }

          if (task.isRunning) {
            this.logger.warn(`Task ${taskId} is already running, skipping job`);
            return;
          }

          // Проверяем статус задачи
          if (task.status !== TaskStatus.ACTIVE) {
            this.logger.info(`Task ${taskId} is not active (status: ${task.status}), skipping job`);
            return;
          }

          await this.taskProcessorService.processTasks(taskId);
          
          // После выполнения проверяем статус снова и планируем следующий джоб
          const updatedTask = await this.taskModel.findById(taskId);
          if (updatedTask && updatedTask.status === TaskStatus.ACTIVE) {
            await this.scheduleTaskJob(updatedTask);
          }
        }),
      );

      agenda.define(
        'cleanupOldJobs',
        {
          priority: JobPriority.highest,
          lockLifetime: FIVE_MIN,
        },
        this.wrapJob('cleanupOldJobs', async () => {
          await this.cleanupOldJobs();
        }),
      );

      await agenda.every(CRON_CLEANUP_OLD_JOBS, JOB_CLEANUP_OLD_JOBS);
      this.logger.info('Scheduled cleanup job every hour');

      // Планируем только задачи, которые не выполняются в данный момент
      const activeTasks = await this.taskModel.find({ 
        status: TaskStatus.ACTIVE,
        isRunning: false 
      }).exec();
      
      for (const task of activeTasks) {
        await this.scheduleTaskJob(task);
      }
      this.logger.info(`Checked and scheduled ${activeTasks.length} dynamic jobs on startup`);
    } catch (error) {
      this.logger.error('Failed to start agenda:', error);
    }
  }

  private async resetAllTaskLocks(): Promise<void> {
    try {
      const result = await this.taskModel.updateMany({ isRunning: true }, { isRunning: false });
      this.logTaskLockReset(result.modifiedCount);
    } catch (error) {
      this.logger.error('Failed to reset task locks:', error);
    }
  }

  private async resetLockedAgendaJobs(): Promise<void> {
    try {
      // Увеличиваем время для сброса заблокированных джобов
      const fifteenMinutesAgo = new Date(Date.now() - this.TASK_LOCK_LIFETIME);
      const lockedJobs = await agenda.jobs({
        name: 'runTask',
        lastRunAt: { $lt: fifteenMinutesAgo },
        lastFinishedAt: { $exists: false },
      });

      if (lockedJobs.length > 0) {
        await agenda.cancel({ name: 'runTask', lastRunAt: { $lt: fifteenMinutesAgo } });
        this.logger.info(`Reset ${lockedJobs.length} locked agenda jobs on startup`);
      } else {
        this.logger.info('No locked agenda jobs found to reset');
      }
    } catch (error) {
      this.logger.error('Failed to reset locked agenda jobs:', error);
    }
  }

  private wrapJob(name: string, handler: (job) => Promise<void>) {
    return async (job) => {
      await new JobWrapper(name, handler).execute(job);
    };
  }

  async scheduleTaskJob(task: TaskDocument) {
    const taskId = task._id;
    
    // Отменяем все существующие джобы для этой задачи
    await this.cancelTaskJob(taskId.toString());
    
    // Проверяем статус задачи
    if (task.status !== TaskStatus.ACTIVE) {
      this.logger.info(`Task ${taskId} is not active (status: ${task.status}), skipping scheduling`);
      return;
    }

    // Проверяем, не выполняется ли задача
    if (task.isRunning) {
      this.logger.warn(`Task ${taskId} is currently running, skipping scheduling`);
      return;
    }

    const nextRun = this.calculateNextRun(task);
    if (!nextRun) {
      this.logger.warn(`Task ${taskId} has no valid next run time`);
      return;
    }

    // Добавляем рандомизацию времени запуска
    const randomizedNextRun = this.addTimeRandomization(nextRun);
    
    // Генерируем динамический приоритет
    const dynamicPriority = this.generateTaskPriority(task);

    // Проверяем, нет ли уже запланированного джоба для этой задачи
    const existingJobs = await agenda.jobs({
      name: 'runTask',
      'data.taskId': taskId.toString(),
    });

    if (existingJobs.length > 0) {
      this.logger.warn(`Task ${taskId} already has ${existingJobs.length} scheduled jobs, skipping`);
      return;
    }

    // Планируем джоб с динамическим приоритетом
    await agenda.schedule(randomizedNextRun, 'runTask', { 
      taskId: taskId.toString(),
      priority: dynamicPriority 
    });
    
    this.logger.info(
      `Scheduled runTask for task ${taskId} at ${randomizedNextRun} with priority ${dynamicPriority}`
    );
  }

  async cancelTaskJob(taskId: string) {
    const num = await agenda.cancel({ name: 'runTask', 'data.taskId': taskId });
    if (num > 0) {
      this.logger.info(`Cancelled ${num} jobs for task ${taskId}`);
    }
  }

  calculateNextRun(task: Task): Date | null {
    const now = new Date();
    const [fromHour, fromMin] = task.timeFrom.split(':').map(Number);
    const [toHour, toMin] = task.timeTo.split(':').map(Number);
    const timeFrom = new Date(now);
    timeFrom.setHours(fromHour, fromMin, 0, 0);
    const timeTo = new Date(now);
    timeTo.setHours(toHour, toMin, 0, 0);
    const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : null;
    let nextRun: Date;
    if (lastRun) {
      nextRun = new Date(lastRun.getTime() + (task.intervalMinutes || 1) * 60 * 1_000);
    } else {
      nextRun = timeFrom;
    }
    if (nextRun >= timeFrom && nextRun <= timeTo && nextRun > now) {
      return nextRun;
    }
    if (now > timeTo) {
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      tomorrow.setHours(fromHour, fromMin, 0, 0);
      return tomorrow;
    }

    if (nextRun <= now) {
      const soon = new Date(now.getTime() + 1 * 60 * 1_000);
      if (soon >= timeFrom && soon <= timeTo) return soon;
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      tomorrow.setHours(fromHour, fromMin, 0, 0);
      return tomorrow;
    }
    return null;
  }

  /**
   * Добавляет рандомизацию к времени запуска для предотвращения конфликтов
   */
  private addTimeRandomization(baseTime: Date): Date {
    const offsetSeconds = Math.floor(
      Math.random() * (TIME_RANDOMIZATION.MAX_OFFSET_SECONDS - TIME_RANDOMIZATION.MIN_OFFSET_SECONDS) +
      TIME_RANDOMIZATION.MIN_OFFSET_SECONDS
    );
    
    const randomizedTime = new Date(baseTime.getTime() + offsetSeconds * 1000);
    
    this.logger.debug(
      `Time randomization: base=${baseTime.toISOString()}, offset=${offsetSeconds}s, result=${randomizedTime.toISOString()}`
    );
    
    return randomizedTime;
  }

  /**
   * Генерирует динамический приоритет для задачи на основе различных факторов
   */
  private generateTaskPriority(task: TaskDocument): number {
    let priority = TASK_PRIORITY_RANGES.NORMAL.min;
    
    // Фактор 1: Время с последнего запуска (чем дольше не запускалась, тем выше приоритет)
    if (task.lastRunAt) {
      const hoursSinceLastRun = (Date.now() - task.lastRunAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastRun > 24) {
        priority = TASK_PRIORITY_RANGES.URGENT.min;
      } else if (hoursSinceLastRun > 12) {
        priority = TASK_PRIORITY_RANGES.HIGH.min;
      } else if (hoursSinceLastRun > 6) {
        priority = TASK_PRIORITY_RANGES.NORMAL.min;
      } else {
        priority = TASK_PRIORITY_RANGES.LOW.min;
      }
    } else {
      // Если задача никогда не запускалась, даем высокий приоритет
      priority = TASK_PRIORITY_RANGES.HIGH.min;
    }
    
    // Фактор 2: Интервал выполнения (короткие интервалы = более высокий приоритет)
    if (task.intervalMinutes <= 5) {
      priority += 2;
    } else if (task.intervalMinutes <= 15) {
      priority += 1;
    } else if (task.intervalMinutes >= 60) {
      priority -= 1;
    }
    
    // Фактор 3: Случайный фактор для предотвращения конфликтов
    const randomFactor = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
    priority += randomFactor;
    
    // Ограничиваем приоритет в допустимых пределах
    priority = Math.max(TASK_PRIORITY_RANGES.BACKGROUND.min, priority);
    priority = Math.min(TASK_PRIORITY_RANGES.URGENT.max, priority);
    
    this.logger.debug(
      `Generated priority ${priority} for task ${task._id} (lastRun: ${task.lastRunAt}, interval: ${task.intervalMinutes}min)`
    );
    
    return priority;
  }

  private async cleanupOldJobs(): Promise<void> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1_000);

      const failedJobs = await agenda.jobs({
        name: 'runTask',
        lastFinishedAt: { $lt: oneDayAgo },
        failedAt: { $exists: true },
      });

      if (failedJobs.length > 0) {
        await agenda.cancel({
          name: 'runTask',
          lastFinishedAt: { $lt: oneDayAgo },
          failedAt: { $exists: true },
        });
        this.logger.info(`Cleaned up ${failedJobs.length} old failed jobs`);
      }

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
      const completedJobs = await agenda.jobs({
        name: 'runTask',
        lastFinishedAt: { $lt: sevenDaysAgo },
        failedAt: { $exists: false },
      });

      if (completedJobs.length > 0) {
        await agenda.cancel({
          name: 'runTask',
          lastFinishedAt: { $lt: sevenDaysAgo },
          failedAt: { $exists: false },
        });
        this.logger.info(`Cleaned up ${completedJobs.length} old completed jobs`);
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old jobs:', error);
    }
  }

  private logTaskLockReset(modifiedCount: number): void {
    if (modifiedCount > 0) {
      this.logger.info(`Reset ${modifiedCount} task locks on server startup`);
    } else {
      this.logger.info('No task locks found to reset');
    }
  }

  // Метод для мониторинга состояния джобов
  async getJobsStatus(): Promise<{
    totalJobs: number;
    runningJobs: number;
    scheduledJobs: number;
    failedJobs: number;
    activeTasks: number;
    runningTasks: number;
  }> {
    try {
      const allJobs = await agenda.jobs({ name: 'runTask' });
      const runningJobs = allJobs.filter(job => !job.attrs.lastFinishedAt);
      const scheduledJobs = allJobs.filter(job => job.attrs.nextRunAt);
      const failedJobs = allJobs.filter(job => job.attrs.failedAt);

      const activeTasks = await this.taskModel.countDocuments({ status: TaskStatus.ACTIVE });
      const runningTasks = await this.taskModel.countDocuments({ isRunning: true });

      return {
        totalJobs: allJobs.length,
        runningJobs: runningJobs.length,
        scheduledJobs: scheduledJobs.length,
        failedJobs: failedJobs.length,
        activeTasks,
        runningTasks,
      };
    } catch (error) {
      this.logger.error('Failed to get jobs status:', error);
      return {
        totalJobs: 0,
        runningJobs: 0,
        scheduledJobs: 0,
        failedJobs: 0,
        activeTasks: 0,
        runningTasks: 0,
      };
    }
  }

  // Метод для принудительной очистки заблокированных задач
  async forceCleanupStuckTasks(): Promise<number> {
    try {
      const result = await this.taskModel.updateMany(
        { isRunning: true },
        { isRunning: false }
      );
      
      if (result.modifiedCount > 0) {
        this.logger.info(`Force cleaned up ${result.modifiedCount} stuck tasks`);
      }
      
      return result.modifiedCount;
    } catch (error) {
      this.logger.error('Failed to force cleanup stuck tasks:', error);
      return 0;
    }
  }

  // Метод для получения статуса очереди задач
  async getTaskQueueStatus() {
    return this.taskProcessorService.getQueueStatus();
  }

  // Метод для очистки очереди задач
  async clearTaskQueue(): Promise<number> {
    return this.taskProcessorService.clearQueue();
  }

  // Метод для получения статистики приоритетов джобов
  async getJobPriorityStats(): Promise<{
    totalJobs: number;
    priorityDistribution: Record<string, number>;
    averagePriority: number;
  }> {
    try {
      const allJobs = await agenda.jobs({ name: 'runTask' });
      const priorityCounts: Record<string, number> = {};
      let totalPriority = 0;

      allJobs.forEach(job => {
        const priority = job.attrs.data?.priority || 0;
        const priorityRange = this.getPriorityRange(priority);
        priorityCounts[priorityRange] = (priorityCounts[priorityRange] || 0) + 1;
        totalPriority += priority;
      });

      return {
        totalJobs: allJobs.length,
        priorityDistribution: priorityCounts,
        averagePriority: allJobs.length > 0 ? totalPriority / allJobs.length : 0,
      };
    } catch (error) {
      this.logger.error('Failed to get job priority stats:', error);
      return {
        totalJobs: 0,
        priorityDistribution: {},
        averagePriority: 0,
      };
    }
  }

  private getPriorityRange(priority: number): string {
    if (priority >= TASK_PRIORITY_RANGES.URGENT.min) return 'URGENT';
    if (priority >= TASK_PRIORITY_RANGES.HIGH.min) return 'HIGH';
    if (priority >= TASK_PRIORITY_RANGES.NORMAL.min) return 'NORMAL';
    if (priority >= TASK_PRIORITY_RANGES.LOW.min) return 'LOW';
    return 'BACKGROUND';
  }

  // Метод для получения статистики браузеров
  async getBrowserStats() {
    return this.taskProcessorService.getBrowserStats();
  }
}
