import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  CreateTaskDto,
  TaskDto,
  TaskListResponseDto,
} from '@task/dto/task.dto';
import { Task, TaskDocument } from './task.schema';
import { FilterQuery, Model } from 'mongoose';
import { GeoProfileDto } from '@geo-profile/dto/geo-profile.dto';

@Injectable()
export class TaskService {
  constructor(@InjectModel(Task.name) private taskModel: Model<Task>) {}

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
        success: 0,
      },
    });

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
      applicationsNumber: task.applicationsNumber,
      timeFrom: task.timeFrom,
      timeTo: task.timeTo,
      result: task.result,
      status: task.status,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
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
      }>('profileId', 'name geo leadKey userAgentKey fbclidKey createdBy createdAt', 'GeoProfile')
      .lean()
      .exec();

    const items = tasks.map((task) => {
      return {
        _id: task._id.toString(),
        url: task.url,
        geo: task.geo,
        createdBy: task.createdBy,
        profile: task.profileId,
        intervalMinutes: task.intervalMinutes,
        applicationsNumber: task.applicationsNumber,
        timeFrom: task.timeFrom,
        timeTo: task.timeTo,
        result: task.result,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      };
    });

    return {
      items,
      total,
      hasMore: skip + tasks.length < total,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.taskModel.findByIdAndDelete(taskId).exec();
  }
}
