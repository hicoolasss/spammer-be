import { GlobalRoles } from '@enums';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { LogWrapper } from '@utils';

@Injectable()
export class IsAdminGuard implements CanActivate {
  private readonly logger = new LogWrapper(IsAdminGuard.name);

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const response = ctx.switchToHttp().getResponse();
    const user = response.locals.user;

    if (!user) {
      await this.logger.warn('Authentication failed: user is undefined');
      throw new ForbiddenException('User not authenticated');
    }

    if (user.role !== GlobalRoles.ADMIN) {
      await this.logger.warn(`Access denied for user ${JSON.stringify(user)}`);
      throw new ForbiddenException('Access denied');
    }

    return true;
  }
}
