import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

export class SignUpDto {
  @IsNotEmpty({ message: "Email must not be empty" })
  @IsEmail({}, { message: "Invalid email" })
  email: string;

  @IsNotEmpty({ message: "Password must not be empty" })
  @MinLength(6, { message: "Password must be at least 6 characters long" })
  password: string;

  @IsOptional()
  telegram?: string;

  @IsString()
  @IsNotEmpty()
  captchaToken: string;
}
