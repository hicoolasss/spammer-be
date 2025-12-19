import { TaskStatus } from '@enums';
import { GeoProfileDto } from '@geo-profile/dto/geo-profile.dto';

export interface TaskDto {
  _id: string;
  url: string;
  geo: string;
  profile?: GeoProfileDto;
  result?: TaskStatisticsDto;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  shouldClickRedirectLink?: boolean;
  isQuiz?: boolean;
}

export interface TaskStatisticsDto {
  total: number;
  successCount: number;
  redirects: Array<{
    url: string;
    at: string;
  }>;
}

export interface CreateTaskDto {
  url: string;
  geo: string;
  profileId?: string;
  applicationsNumber: number;
  shouldClickRedirectLink?: boolean;
  isQuiz?: boolean;
}

export interface UpdateTaskDto {
  url?: string;
  geo?: string;
  profileId?: string | null;
  status?: TaskStatus;
  applicationsNumber?: number;
  shouldClickRedirectLink?: boolean;
  isQuiz?: boolean;
}

export interface TaskListResponseDto {
  items: TaskDto[];
  total: number;
  hasMore: boolean;
}
