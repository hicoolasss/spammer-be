import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateGeoProfileDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  geo: string;
}

export class UpdateGeoProfileDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  geo?: string;
}
