import { TaskStatus } from '@enums';
import { GeoProfileDto } from '@geo-profile/dto/geo-profile.dto';
import { TaskResult } from '@interfaces';

export interface TaskDto {
  _id: string;
  url: string;
  geo: string;
  profile: GeoProfileDto;
  intervalMinutes: number;
  applicationsNumber: number;
  timeFrom: string;
  timeTo: string;
  result?: TaskResult;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  shouldClickRedirectLink?: boolean;
}

export interface CreateTaskDto {
  url: string;
  geo: string;
  profileId: string;
  intervalMinutes: number;
  applicationsNumber: number;
  timeFrom: string;
  timeTo: string;
  shouldClickRedirectLink?: boolean;
}

export interface TaskListResponseDto {
  items: TaskDto[];
  total: number;
  hasMore: boolean;
}
