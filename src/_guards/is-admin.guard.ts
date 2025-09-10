import { GlobalRoles } from '@enums';
import { Injectable } from '@nestjs/common';

import { BaseRoleGuard } from './base-role.guard';

@Injectable()
export class IsAdminGuard extends BaseRoleGuard {
  getRequiredRole(): GlobalRoles {
    return GlobalRoles.ADMIN;
  }
}
