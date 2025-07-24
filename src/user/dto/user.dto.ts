import { GlobalRoles, SubscriptionPlan } from '@enums';
import { IsEmail, IsIn, IsOptional } from 'class-validator';

export class UserDto {
  @IsOptional()
  _id?: string;

  @IsOptional()
  telegram?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  password?: string;

  @IsOptional()
  @IsIn(Object.values(SubscriptionPlan))
  plan?: {
    name: SubscriptionPlan;
    endAt: Date;
  };

  @IsOptional()
  @IsIn(Object.values(GlobalRoles))
  role?: GlobalRoles;

  @IsOptional()
  emailVerified?: boolean;
}
