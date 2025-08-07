import { Injectable } from '@nestjs/common';
import { LogWrapper } from '@utils';

export interface QueuedTask {
  taskId: string;
  priority: number;
  addedAt: Date;
}

@Injectable()
export class TaskQueueManager {
  private readonly logger = new LogWrapper(TaskQueueManager.name);
  private taskQueue: QueuedTask[] = [];
  private isProcessingQueue = false;
  private processingLock: Promise<void> | null = null;

  addTaskToQueue(taskId: string, priority: number = 1): void {
    const queuedTask: QueuedTask = {
      taskId,
      priority,
      addedAt: new Date(),
    };
    this.taskQueue.push(queuedTask);
    this.logger.info(`📋 Added task ${taskId} to queue (priority: ${priority}, queue length: ${this.taskQueue.length})`);
  }

  getNextTask(): QueuedTask | undefined {
    if (this.taskQueue.length === 0) {
      return undefined;
    }
    
    const task = this.taskQueue.shift();
    this.logger.debug(`🎯 Retrieved task ${task?.taskId} from queue (remaining: ${this.taskQueue.length})`);
    return task;
  }

  getQueueLength(): number {
    return this.taskQueue.length;
  }

  isQueueEmpty(): boolean {
    return this.taskQueue.length === 0;
  }

  setProcessingStatus(isProcessing: boolean): void {
    this.isProcessingQueue = isProcessing;
    this.logger.info(`🔄 Queue processing status: ${isProcessing ? 'STARTED' : 'STOPPED'}`);
  }

  isCurrentlyProcessing(): boolean {
    return this.isProcessingQueue;
  }

  async acquireProcessingLock(): Promise<void> {
    if (this.processingLock) {
      this.logger.debug(`⏳ Waiting for processing lock...`);
      await this.processingLock;
    }
    
    this.processingLock = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.processingLock = null;
        resolve();
      }, 100);
    });
  }

  getQueueStatistics() {
    const oldestTask = this.taskQueue.length > 0 ? this.taskQueue[0].addedAt : null;
    const newestTask = this.taskQueue.length > 0 ? this.taskQueue[this.taskQueue.length - 1].addedAt : null;
    
    return {
      queueLength: this.taskQueue.length,
      isProcessing: this.isProcessingQueue,
      oldestTask,
      newestTask,
      averageWaitTime: this.calculateAverageWaitTime(),
      priorityDistribution: this.getPriorityDistribution(),
    };
  }

  private calculateAverageWaitTime(): number {
    if (this.taskQueue.length === 0) return 0;
    
    const now = new Date();
    const totalWaitTime = this.taskQueue.reduce((sum, task) => {
      return sum + (now.getTime() - task.addedAt.getTime());
    }, 0);
    
    return Math.round(totalWaitTime / this.taskQueue.length);
  }

  private getPriorityDistribution(): Record<number, number> {
    const distribution: Record<number, number> = {};
    
    for (const task of this.taskQueue) {
      distribution[task.priority] = (distribution[task.priority] || 0) + 1;
    }
    
    return distribution;
  }

  clearQueue(): void {
    const queueLength = this.taskQueue.length;
    this.taskQueue = [];
    this.logger.info(`🗑️ Queue cleared (removed ${queueLength} tasks)`);
  }

  getTaskById(taskId: string): QueuedTask | undefined {
    return this.taskQueue.find(task => task.taskId === taskId);
  }

  removeTaskById(taskId: string): boolean {
    const initialLength = this.taskQueue.length;
    this.taskQueue = this.taskQueue.filter(task => task.taskId !== taskId);
    const removed = initialLength !== this.taskQueue.length;
    
    if (removed) {
      this.logger.info(`🗑️ Removed task ${taskId} from queue`);
    }
    
    return removed;
  }

  getQueueSnapshot(): QueuedTask[] {
    return [...this.taskQueue];
  }
} 