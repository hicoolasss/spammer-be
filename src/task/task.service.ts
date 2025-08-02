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
import { FilterQuery, Model } from 'mongoose';

import { AgendaService } from '../jobs/agenda.service';
import { Task, TaskDocument } from './task.schema';

@Injectable()
export class TaskService {
  constructor(
    @InjectModel(Task.name) private taskModel: Model<Task>,
    private readonly agendaService: AgendaService,
  ) {}

  async createTask(dto: CreateTaskDto, userId: string): Promise<TaskDto> {
    const created = await this.taskModel.create({
      url: dto.url,
      geo: dto.geo,
      profileId: dto.profileId,
      createdBy: userId,
      intervalMinutes: dto.intervalMinutes,
      applicationsNumber: dto.applicationsNumber,
      timeFrom: dto.timeFrom,
      timeTo: dto.timeTo,
      result: {
        total: 0,
        success: {},
      },
      shouldClickRedirectLink: dto.shouldClickRedirectLink ?? false,
      isQuiz: dto.isQuiz ?? false,
    });

    await this.rescheduleAgendaJob(created);

    const task = await this.taskModel
      .findById(created._id)
      .populate<{ profileId: GeoProfileDto }>({
        path: 'profileId',
        select: 'name geo',
      })
      .exec();

    const profile = task.profileId!;
    return {
      _id: task._id.toString(),
      url: task.url,
      geo: task.geo,

      createdBy: task.createdBy,
      profile: profile,
      intervalMinutes: task.intervalMinutes,
      timeFrom: task.timeFrom,
      timeTo: task.timeTo,
      result: {
        total: 0,
        successCount: 0,
        redirects: [],
      },
      status: task.status,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      shouldClickRedirectLink: task.shouldClickRedirectLink,
      isQuiz: task.isQuiz,
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

        return {
          _id: task._id.toString(),
          url: task.url,
          geo: task.geo,
          createdBy: task.createdBy,
          profile: task.profileId,
          intervalMinutes: task.intervalMinutes,
          timeFrom: task.timeFrom,
          timeTo: task.timeTo,
          result,
          status: task.status,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
          shouldClickRedirectLink: task.shouldClickRedirectLink,
          isQuiz: task.isQuiz,
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
    await this.taskModel.findByIdAndDelete(taskId).exec();
    await this.agendaService.cancelTaskJob(taskId);
  }

  async updateTask(taskId: string, dto: UpdateTaskDto): Promise<TaskDto> {
    const task = await this.taskModel.findById(taskId);

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    Object.assign(task, dto);
    await task.save();
    await this.rescheduleAgendaJob(task);
    const populatedTask = await this.taskModel
      .findById(taskId)
      .populate<{ profileId: GeoProfileDto }>({
        path: 'profileId',
        select:
          'name geo leadKey userAgentKey fbclidKey leadCount userAgentCount fbclidCount createdBy createdAt',
      })
      .exec();

    const result = await this.getTaskStatistics(populatedTask!._id.toString());

    return {
      _id: populatedTask!._id.toString(),
      url: populatedTask!.url,
      geo: populatedTask!.geo,
      createdBy: populatedTask!.createdBy,
      profile: populatedTask!.profileId,
      intervalMinutes: populatedTask!.intervalMinutes,
      timeFrom: populatedTask!.timeFrom,
      timeTo: populatedTask!.timeTo,
      result,
      status: populatedTask!.status,
      createdAt: populatedTask!.createdAt.toISOString(),
      updatedAt: populatedTask!.updatedAt.toISOString(),
      shouldClickRedirectLink: populatedTask!.shouldClickRedirectLink,
      isQuiz: populatedTask!.isQuiz,
    };
  }

  private async getTaskStatistics(taskId: string): Promise<TaskStatisticsDto> {
    const task = await this.taskModel.findById(taskId).exec();

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    const result = task.result || { total: 0, success: {} };
    const successObj = (result.success as Record<string, number>) || {};

    const successCount = Object.values(successObj).reduce((sum, count) => sum + count, 0);

    const redirects = Object.entries(successObj)
      .map(([url, count]) => ({
        url,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total: result.total || 0,
      successCount,
      redirects,
    };
  }

  private async rescheduleAgendaJob(task: TaskDocument) {
    const taskId = task._id.toString();
    if (task.status === TaskStatus.ACTIVE) {
      await this.agendaService.scheduleTaskJob(task);
    } else if (taskId) {
      await this.agendaService.cancelTaskJob(taskId);
    }
  }
}
