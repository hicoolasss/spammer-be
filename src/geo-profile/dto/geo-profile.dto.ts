export interface GeoProfileDto {
  _id: string;
  name: string;
  geo: string;
  leadKey?: string;
  userAgentKey?: string;
  fbclidKey?: string;
  createdBy: string;
  createdAt: Date;
  leadCount?: number;
  userAgentCount?: number;
  fbclidCount?: number;
}

export interface TaskGeoProfileDto {
  _id: string;
  name: string;
  geo: string;
}

export interface GeoProfileListResponseDto {
  items: GeoProfileDto[];
  total: number;
  hasMore: boolean;
}
