import { CountryCode } from "@enums";
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from "class-validator";

export class EditGeoDto {
  @IsArray()
  @IsEnum(CountryCode, { each: true })
  regions: CountryCode[];

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsNumber()
  port?: number;

  @IsOptional()
  @IsString()
  host?: string;
}
