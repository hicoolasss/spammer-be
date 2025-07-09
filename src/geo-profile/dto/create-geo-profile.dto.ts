import { IsNotEmpty, IsString } from 'class-validator';

export class CreateGeoProfileDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  geo: string;
}
