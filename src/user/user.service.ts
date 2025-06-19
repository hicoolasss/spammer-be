import { DEFAULT_USER_PLAN, GlobalRoles } from "@enums";
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { LogWrapper } from "@utils/LogWrapper";
import * as bcrypt from "bcryptjs";
import { FilterQuery, Model } from "mongoose";
import { telegramRegex } from "src/validations/consts";

import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UserDto } from "./dto/user.dto";
import { User, UserDocument } from "./user.schema";

@Injectable()
export class UserService {
  private readonly logger = new LogWrapper(UserService.name);

  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>
  ) {}

  async createNewUser(
    user: UserDto,
    referralId?: string
  ): Promise<UserDocument> {
    const hashedPassword = await this.hashPassword(user.password);

    const createdUser = new this.userModel({
      ...user,
      password: hashedPassword,
      emailVerified: false,
      role: GlobalRoles.USER,
      plan: DEFAULT_USER_PLAN,
      referralLinkId: referralId,
    });

    return createdUser.save();
  }

  async getUserDtoById(id: string): Promise<UserDto> {
    const userDocument = await this.userModel.findById(id).exec();

    if (!userDocument) {
      throw new BadRequestException("User not found");
    }

    const userDto: UserDto = {
      _id: id,
      email: userDocument.email,
      role: userDocument.role,
      telegram: userDocument.telegram,
      emailVerified: userDocument.emailVerified,
    };

    return userDto;
  }

  async getUserEmailById(id: string): Promise<string> {
    const user = await this.userModel
      .findById(id)
      .select("email")
      .lean()
      .exec();

    if (!user) {
      throw new BadRequestException("User not found");
    }

    return user.email;
  }

  async findById(id: string): Promise<UserDocument> {
    const user = this.userModel.findById(id).exec();

    if (!user) {
      throw new BadRequestException("User not found");
    }

    return user;
  }

  async findByEmail(email: string): Promise<UserDocument> {
    return this.userModel.findOne({ email }).exec();
  }

  async updateRefreshToken(userId: string, refreshToken: string) {
    await this.userModel.updateOne({ _id: userId }, { refreshToken }).exec();
  }

  async update(user: UserDocument): Promise<UserDocument> {
    return this.userModel
      .findByIdAndUpdate(user._id, user, { new: true })
      .exec();
  }

  async updatePassword(userId: string, newPassword: string) {
    const hashedPassword = await this.hashPassword(newPassword);
    await this.userModel
      .updateOne({ _id: userId }, { password: hashedPassword })
      .exec();
  }

  async delete(userId: string): Promise<void> {
    await this.userModel.deleteOne({ _id: userId }).exec();
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserDto> {
    try {
      const user = await this.findById(userId);

      if (dto.telegram !== undefined) {
        if (!telegramRegex.test(dto.telegram)) {
          throw new BadRequestException("Telegram username is invalid");
        }
        user.telegram = dto.telegram;
      }

      if (dto.email !== undefined) {
        user.email = dto.email;
        user.emailVerified = false;
      }

      if (dto.password !== undefined) {
        this.updatePassword(userId, dto.password);
      }

      await user.save();
      return this.toDto(user);
    } catch (error) {
      this.logger.error(`Error in updateProfile: ${error}`);
      throw error;
    }
  }

  async getAllUsers(
    skip: number,
    limit: number,
    searchQuery?: string,
    sortBy?: string,
    sortOrder: "asc" | "desc" = "asc",
    plan?: string,
    role?: string
  ): Promise<{ users: UserDto[]; total: number }> {
    try {
      const filter: FilterQuery<User> = {};

      if (searchQuery) {
        filter.$or = [
          { email: { $regex: searchQuery, $options: "i" } },
          { telegram: { $regex: searchQuery, $options: "i" } },
        ];
      }

      if (role && role !== "all") {
        filter.role = role;
      }

      type SortValue = 1 | -1;
      const sortOptions: Record<string, SortValue> = {};

      if (sortBy) {
        sortOptions[sortBy] = sortOrder === "asc" ? 1 : -1;
      } else {
        sortOptions.email = 1;
      }

      const [allUsers, total] = await Promise.all([
        this.userModel
          .find(filter)
          .skip(skip)
          .limit(limit)
          .sort(sortOptions)
          .exec(),
        this.userModel.countDocuments(filter).exec(),
      ]);

      const userDto = allUsers.map((user) => ({
        _id: user._id as string,
        email: user.email,
        role: user.role,
        telegram: user.telegram,
        emailVerified: user.emailVerified,
      }));

      return { users: userDto, total };
    } catch (error) {
      this.logger.error(`Error in getAllUsers: ${error}`);
      throw error;
    }
  }

  async findUsersByIds(userIds: string[]) {
    return this.userModel.find({ _id: { $in: userIds } }).exec();
  }

  async deleteUserAccount(userId: string): Promise<void> {
    await this.userModel.findByIdAndDelete(userId);
  }

  async changeUserRole(userId: string, role: GlobalRoles): Promise<UserDto> {
    const user = await this.findById(userId);
    const { role: currentRole } = user;
    const isAdmin = currentRole === GlobalRoles.ADMIN;

    if (isAdmin) {
      await this.logger.warn(
        `Admin user: ${userId}, was demoted to the '${role}' role`
      );
    }

    user.role = role;

    await user.save();
    return this.toDto(user);
  }

  async isAdminOrAdvertiserRole(userId: string): Promise<boolean> {
    const user = await this.findById(userId);
    const { role } = user;
    return [GlobalRoles.ADMIN, GlobalRoles.ADVERTISER].includes(role);
  }

  async permanentlyVerifyEmail(userId: string) {
    const user = await this.findById(userId);
    user.emailVerified = true;

    await user.save();
  }

  private toDto(user: UserDocument): UserDto {
    return {
      _id: user._id.toString(),
      email: user.email,
      role: user.role,
      telegram: user.telegram,
      emailVerified: user.emailVerified,
    };
  }

  private async hashPassword(password: string): Promise<string> {
    const hashedPassword = await bcrypt.hash(
      password,
      Number(process.env.CRYPTO_SALT)
    );

    return hashedPassword;
  }
}
