export class GeoProfileResponseDto {
  id: string;
  name: string;
  geo: string;
  leadKey?: string;
  userAgentKey?: string;
  fbclidKey?: string;
  createdBy: string;
  createdAt: Date;
  leadCount: number;
  userAgentCount?: number;
  fbclidCount?: number;
}
