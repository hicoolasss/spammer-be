import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Task } from '@task/task.schema';
import { LogWrapper, TaskLogger } from '@utils';
import { Model } from 'mongoose';

@Injectable()
export class TaskStatisticsService {
  private readonly logger = new LogWrapper(TaskStatisticsService.name);

  constructor(@InjectModel(Task.name) private taskModel: Model<Task>) {}

  async updateTaskStatistics(
    taskId: string,
    finalRedirectUrl: string | null,
    visitedUrls: string[],
    success: boolean,
    error?: string,
  ): Promise<void> {
    const taskLogger = new TaskLogger(TaskStatisticsService.name, taskId);

    try {
      const task = await this.taskModel.findById(taskId).exec();
      if (!task) {
        taskLogger.error('Task not found for statistics update');
        return;
      }

      if (finalRedirectUrl) {
        taskLogger.info(`✅ Successful redirect to: ${finalRedirectUrl}`);
      }

      const currentStats = (task as any).statistics || { total: 0, success: 0, failed: 0 };
      currentStats.total += 1;

      if (success) {
        currentStats.success += 1;
        taskLogger.info(`📊 Statistics updated for task ${taskId}: total=${currentStats.total}, success=${currentStats.success}, failed=${currentStats.failed}`);
      } else {
        currentStats.failed += 1;
        taskLogger.error(`❌ Task failed: ${error}`);
      }

      (task as any).statistics = currentStats;
      await task.save();
    } catch (error) {
      taskLogger.error(`Failed to update task statistics: ${error.message}`);
    }
  }

  async getTaskStatistics(taskId: string): Promise<any> {
    const task = await this.taskModel.findById(taskId).exec();
    if (!task) {
      return null;
    }

    return {
      taskId,
      statistics: (task as any).statistics || { total: 0, success: 0, failed: 0 },
      lastRunAt: task.lastRunAt,
      status: task.status,
    };
  }
} 