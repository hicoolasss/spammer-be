import { IsString, IsNotEmpty } from 'class-validator';

export class CreateGeoProfileDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  geo: string;
}
