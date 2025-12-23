
import { GlobalRoles } from "@enums";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";

@Injectable()
export abstract class BaseRoleGuard implements CanActivate {
  abstract getRequiredRole(): GlobalRoles;

  canActivate(context: ExecutionContext): boolean {
    const response = context.switchToHttp().getResponse();
    const user = response.locals.user;

    if (!user) {
      throw new ForbiddenException("User not authenticated");
    }

    const requiredRole = this.getRequiredRole();
    
    if (!user.role || user.role !== requiredRole) {
      throw new ForbiddenException("Access denied");
    }

    return true;
  }
}
