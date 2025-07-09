import { IsEmail, IsNotEmpty } from 'class-validator';

export class RequestEmailConfirmationDto {
  @IsNotEmpty({ message: 'Email must not be empty' })
  @IsEmail({}, { message: 'Invalid email' })
  email: string;
}
