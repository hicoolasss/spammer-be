import { IsNotEmpty, MinLength } from "class-validator";

export class ValidatePasswordResetDto {
  @IsNotEmpty({ message: "New password must not be empty" })
  @MinLength(6, { message: "Password must be at least 6 characters long" })
  password: string;
}
