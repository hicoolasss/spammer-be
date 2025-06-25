import { CurrentUser } from '@_decorators';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { UserDto } from '@user/dto/user.dto';
import { CreateGeoProfileDto } from '@geo-profile/dto/create-geo-profile.dto';
import { GeoProfileService } from '@geo-profile/geo-profile.service';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { csvMulterOptions } from '@_config/multer.config';
import { GeoProfileResponseDto } from '@geo-profile/dto/geo-profile.dto';

@Controller('geo-profile')
export class GeoProfileController {
  constructor(private readonly geoProfileService: GeoProfileService) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'leadData', maxCount: 1 },
        { name: 'userAgents', maxCount: 1 },
        { name: 'fbClids', maxCount: 1 },
      ],
      csvMulterOptions,
    ),
  )
  async create(
    @UploadedFiles()
    files: {
      leadData?: Express.Multer.File[];
      userAgents?: Express.Multer.File[];
      fbClids?: Express.Multer.File[];
    },
    @Body() dto: CreateGeoProfileDto,
    @CurrentUser() user: UserDto,
  ): Promise<GeoProfileResponseDto> {
    const result = await this.geoProfileService.createGeoProfile(
      dto,
      {
        leadDataPath: files.leadData[0].path,
        userAgentsPath: files.userAgents?.[0]?.path,
        fbClidsPath: files.fbClids?.[0]?.path,
      },
      user._id,
    );

    return result;
  }

  @Get('all/user/:userId')
  async list(
    @Param('userId') userId: string,
  ): Promise<GeoProfileResponseDto[]> {
    return this.geoProfileService.findAllByUser(userId);
  }
}
