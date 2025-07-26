import { TaskStatus } from '@enums';
import { GeoProfileDto } from '@geo-profile/dto/geo-profile.dto';

export interface TaskDto {
  _id: string;
  url: string;
  geo: string;
  profile: GeoProfileDto;
  intervalMinutes: number;
  timeFrom: string;
  timeTo: string;
  result?: TaskStatisticsDto;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  shouldClickRedirectLink?: boolean;
}

export interface TaskStatisticsDto {
  total: number;
  successCount: number;
  redirects: Array<{
    url: string;
    count: number;
  }>;
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

export interface UpdateTaskDto {
  url?: string;
  geo?: string;
  profileId?: string;
  intervalMinutes?: number;
  applicationsNumber?: number;
  timeFrom?: string;
  timeTo?: string;
  shouldClickRedirectLink?: boolean;
}

export interface TaskListResponseDto {
  items: TaskDto[];
  total: number;
  hasMore: boolean;
}
