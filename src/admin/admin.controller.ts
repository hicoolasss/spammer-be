import { IsAdminGuard } from "@_guards";
import { GlobalRoles } from "@enums";
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { UserDto } from "@user/dto/user.dto";
import { UserService } from "@user/user.service";

@Controller("admin")
export class AdminController {
  private readonly logger = new Logger("Admin");

  constructor(private readonly userService: UserService) {}

  @UseGuards(AuthGuard("jwt"), IsAdminGuard)
  @Get("is-admin")
  @HttpCode(HttpStatus.OK)
  isAdmin(): void {}

  @UseGuards(AuthGuard("jwt"), IsAdminGuard)
  @Get("users")
  async getAllUsers(
    @Query("skip", new DefaultValuePipe(0), ParseIntPipe) skip: number,
    @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query("searchQuery") searchQuery?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortOrder") sortOrder: "asc" | "desc" = "asc",
    @Query("plan") plan?: string,
    @Query("role") role?: string
  ) {
    skip = Math.max(0, skip);
    limit = limit > 0 ? limit : 10;

    return this.userService.getAllUsers(
      skip,
      limit,
      searchQuery,
      sortBy,
      sortOrder,
      plan,
      role
    );
  }

  @UseGuards(AuthGuard("jwt"), IsAdminGuard)
  @Patch("users/change-role/:id")
  async changeRole(
    @Param("id") userId: string,
    @Body("role") role: GlobalRoles
  ): Promise<UserDto> {
    const user = await this.userService.changeUserRole(userId, role);
    return user;
  }
}
