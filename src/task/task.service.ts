import { TaskStatus } from '@enums';
import { GeoProfileDto } from '@geo-profile/dto/geo-profile.dto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  CreateTaskDto,
  TaskDto,
  TaskListResponseDto,
  TaskStatisticsDto,
  UpdateTaskDto,
} from '@task/dto/task.dto';
import { LogWrapper } from '@utils';
import { FilterQuery, Model } from 'mongoose';

import { BullMQService } from '../jobs/bullmq.service';
import { Task, TaskDocument } from './task.schema';

@Injectable()
export class TaskService {
  private readonly logger = new LogWrapper(TaskService.name);

  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    private readonly bullMQService: BullMQService,
  ) {}

  async createTask(dto: CreateTaskDto, userId: string): Promise<TaskDto> {
    const created = await this.taskModel.create({
      url: dto.url,
      geo: dto.geo,
      profileId: dto.profileId,
      createdBy: userId,
      applicationsNumber: dto.applicationsNumber,
      result: {
        total: 0,
        redirects: [],
      },
      shouldClickRedirectLink: dto.shouldClickRedirectLink ?? false,
      isQuiz: dto.isQuiz ?? false,
      isCaptcha: dto.isCaptcha ?? false,
    });
  
    const task = await this.taskModel
      .findById(created._id)
      .populate<{ profileId: GeoProfileDto }>({
        path: 'profileId',
        select: 'name geo',
      })
      .exec();
  
    try {
      if (task && task.status === TaskStatus.ACTIVE) {
        await this.bullMQService.enqueueTaskLoop(task._id.toString());
      } else {
        this.logger.info(
          `[TASK_CREATE] Task ${created._id} created with status=${task?.status}, not enqueuing loop`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Error enqueuing loop for task ${created._id}:`, error);
    }
  
    const profile = task.profileId
      ? (task.profileId as unknown as GeoProfileDto)
      : null;
  
    return {
      _id: task!._id.toString(),
      url: task!.url,
      geo: task!.geo,
      createdBy: task!.createdBy,
      profile,
      result: {
        total: 0,
        successCount: 0,
        redirects: [],
      },
      status: task!.status,
      createdAt: task!.createdAt.toISOString(),
      updatedAt: task!.updatedAt.toISOString(),
      shouldClickRedirectLink: task!.shouldClickRedirectLink,
      isQuiz: task!.isQuiz,
      isCaptcha: task!.isCaptcha,
    };
  }  

  async findAllByUser(
    userId: string,
    skip: number,
    limit: number,
    searchQuery: string,
    selectedGeo: string,
  ): Promise<TaskListResponseDto> {
    const filter: FilterQuery<TaskDocument> = { createdBy: userId };

    if (searchQuery) {
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escaped, $options: 'i' };
    }

    if (selectedGeo) {
      filter.geo = selectedGeo;
    }

    const total = await this.taskModel.countDocuments(filter).exec();
    const tasks = await this.taskModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate<{
        profileId: GeoProfileDto;
      }>(
        'profileId',
        'name geo leadKey userAgentKey fbclidKey leadCount userAgentCount fbclidCount createdBy createdAt',
        'GeoProfile',
      )
      .lean()
      .exec();

    const items = await Promise.all(
      tasks.map(async (task) => {
        const result = await this.getTaskStatistics(task._id.toString());
        const profile = task.profileId
      ? (task.profileId as unknown as GeoProfileDto)
      : null;

        return {
          _id: task._id.toString(),
          url: task.url,
          geo: task.geo,
          createdBy: task.createdBy,
          profile,
          result,
          status: task.status,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
          shouldClickRedirectLink: task.shouldClickRedirectLink,
          isQuiz: task.isQuiz,
          isCaptcha: task.isCaptcha,
        };
      }),
    );

    return {
      items,
      total,
      hasMore: skip + tasks.length < total,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    try {
      await this.bullMQService.cancelTask(taskId);
    } catch (error) {
      this.logger.error(`Error cancelling task ${taskId}:`, error);
    }

    await this.taskModel.findByIdAndDelete(taskId).exec();
  }

  async updateTask(taskId: string, dto: UpdateTaskDto): Promise<TaskDto> {
    const task = await this.taskModel.findById(taskId);
  
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
  
    const prevStatus = task.status;
  
    const patch: Partial<UpdateTaskDto> & { status?: TaskStatus } = { ...(dto as any) };
  
    if (Object.prototype.hasOwnProperty.call(dto, 'profileId') && patch.profileId === null) {
      patch.profileId = undefined;
    }
  
    const statusProvided = Object.prototype.hasOwnProperty.call(dto as any, 'status');
    const nextStatus = statusProvided ? (patch as any).status : prevStatus;
  
    const isResuming =
      statusProvided && prevStatus !== TaskStatus.ACTIVE && nextStatus === TaskStatus.ACTIVE;
  
    Object.assign(task, patch);
  
    if (isResuming) {
      task.isRunning = false;
    }
  
    await task.save();
  
    this.logger.info(
      `[TASK_UPDATE] Task ${taskId} updated` +
        (statusProvided ? ` (status: ${prevStatus} -> ${nextStatus})` : '') +
        (Object.prototype.hasOwnProperty.call(dto, 'profileId')
          ? ` (profileId: ${(dto as any).profileId})`
          : ''),
    );
  
    if (isResuming) {
      try {
        await this.bullMQService.enqueueTaskLoop(taskId);
        this.logger.info(`[TASK_UPDATE] Enqueued loop job after resume for task ${taskId}`);
      } catch (e: any) {
        this.logger.error(
          `[TASK_UPDATE] Failed to enqueue loop job for task ${taskId}: ${e?.message ?? e}`,
          e,
        );
      }
    }
  
    const populatedTask = await this.taskModel
      .findById(taskId)
      .populate<{ profileId: GeoProfileDto | null }>({
        path: 'profileId',
        select:
          'name geo leadKey userAgentKey fbclidKey leadCount userAgentCount fbclidCount createdBy createdAt',
      })
      .exec();
  
    const result = await this.getTaskStatistics(populatedTask!._id.toString());
  
    const profile = populatedTask?.profileId
      ? (populatedTask.profileId as unknown as GeoProfileDto)
      : null;
  
    return {
      _id: populatedTask!._id.toString(),
      url: populatedTask!.url,
      geo: populatedTask!.geo,
      createdBy: populatedTask!.createdBy,
      profile,
      result,
      status: populatedTask!.status,
      createdAt: populatedTask!.createdAt.toISOString(),
      updatedAt: populatedTask!.updatedAt.toISOString(),
      shouldClickRedirectLink: populatedTask!.shouldClickRedirectLink,
      isQuiz: populatedTask!.isQuiz,
      isCaptcha: populatedTask!.isCaptcha,
    };
  }

  private async getTaskStatistics(taskId: string): Promise<TaskStatisticsDto> {
    const task = await this.taskModel.findById(taskId).lean().exec();
    if (!task) throw new Error(`Task with ID ${taskId} not found`);

    const result = task.result ?? { total: 0, redirects: [] };

    const redirects = (result.redirects ?? []).map(r => ({
      url: r.url,
      at: new Date(r.at).toISOString(),
    }));

    return {
      total: result.total ?? 0,
      successCount: redirects.length,
      redirects,
    };
  }
}
