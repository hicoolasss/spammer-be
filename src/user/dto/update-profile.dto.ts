import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from "class-validator";

const telegramRegex = /^@[a-zA-Z0-9_]{3,}$/;

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Matches(telegramRegex, {
    message:
      "Telegram username should start with @ and contain at least 3 characters (letters, numbers, or underscores)",
  })
  telegram?: string;

  @IsOptional()
  @IsEmail({}, { message: "Wrong email format" })
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: "New password should be at least 8 characters" })
  password?: string;
}
