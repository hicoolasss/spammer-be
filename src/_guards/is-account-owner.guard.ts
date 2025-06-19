import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { LogWrapper } from "@utils/LogWrapper";

@Injectable()
export class IsAccountOwnerGuard implements CanActivate {
  private readonly logger = new LogWrapper(IsAccountOwnerGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const user = response.locals.user;
    const userIdFromParam = request.params.id || request.body.userId;
    const userIdFromToken = user._id;

    if (!userIdFromToken) {
      await this.logger.warn(
        "Authentication failed: User ID not found in request"
      );
      throw new ForbiddenException("User not authenticated");
    }

    if (userIdFromParam !== userIdFromToken) {
      await this.logger.warn(
        `Access denied. User ID mismatch: token=${userIdFromToken}, param=${userIdFromParam}`
      );
      throw new ForbiddenException(
        "Access denied: You can only access your own account"
      );
    }

    return true;
  }
}
