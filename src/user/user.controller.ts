import { CurrentUser } from "@_decorators";
import { IsAccountOwnerGuard, IsAdminGuard, UseAnyOfGuards } from "@_guards";
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UserDto } from "./dto/user.dto";
import { UserService } from "./user.service";

@Controller("user")
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get("my-profile")
  @UseGuards(AuthGuard("jwt"))
  async getMe(@CurrentUser() user: UserDto) {
    return user;
  }

  @Get("get-user-by-id/:id")
  @UseGuards(
    AuthGuard("jwt"),
    UseAnyOfGuards(IsAccountOwnerGuard, IsAdminGuard)
  )
  async getUserById(@Param("id") id: string) {
    return this.userService.getUserDtoById(id);
  }

  @Patch("profile")
  @UseGuards(
    AuthGuard("jwt"),
    UseAnyOfGuards(IsAccountOwnerGuard, IsAdminGuard)
  )
  async updateProfile(
    @Body() dto: UpdateProfileDto,
    @CurrentUser("id") userId: string
  ): Promise<UserDto> {
    return this.userService.updateProfile(userId, dto);
  }

  @Get("get-all-users")
  @UseGuards(AuthGuard("jwt"), IsAdminGuard)
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

  @Delete("delete-account/:id")
  @UseGuards(AuthGuard("jwt"), IsAdminGuard)
  async deleteAccount(@Param("id") userId: string) {
    await this.userService.deleteUserAccount(userId);
    return { message: "Account deleted successfully" };
  }

  @Patch("permanently-verify-email/:id")
  @UseGuards(AuthGuard("jwt"), IsAdminGuard)
  async permanentlyVerifyEmail(@Param("id") userId: string) {
    await this.userService.permanentlyVerifyEmail(userId);
    return { message: "Email verified successfully" };
  }
}
