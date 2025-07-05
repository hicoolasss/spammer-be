import { CurrentUser } from '@_decorators';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { UserDto } from '@user/dto/user.dto';
import { CreateGeoProfileDto } from '@geo-profile/dto/create-geo-profile.dto';
import { GeoProfileService } from '@geo-profile/geo-profile.service';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { csvMulterOptions } from '@_config/multer.config';
import {
  GeoProfileListResponseDto,
  GeoProfileDto,
} from '@geo-profile/dto/geo-profile.dto';

@Controller('geo-profile')
export class GeoProfileController {
  constructor(private readonly geoProfileService: GeoProfileService) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'leadData', maxCount: 1 },
        { name: 'userAgents', maxCount: 1 },
        { name: 'fbclids', maxCount: 1 },
      ],
      csvMulterOptions,
    ),
  )
  async create(
    @UploadedFiles()
    files: {
      leadData?: Express.Multer.File[];
      userAgents?: Express.Multer.File[];
      fbclids?: Express.Multer.File[];
    },
    @Body() dto: CreateGeoProfileDto,
    @CurrentUser() user: UserDto,
  ): Promise<GeoProfileDto> {
    const result = await this.geoProfileService.createGeoProfile(
      dto,
      {
        leadDataPath: files.leadData[0].path,
        userAgentsPath: files.userAgents?.[0]?.path,
        fbClidsPath: files.fbclids?.[0]?.path,
      },
      user._id,
    );

    return result;
  }

  //TODO
  // @Get('user/:userId')
  // async list(
  //   @Param('userId') userId: string,
  // ): Promise<GeoProfileResponseDto[]> {
  //   return this.geoProfileService.findAllByUser(userId);
  // }

  @Get()
  async listAll(
    @CurrentUser() user: UserDto,
    @Query(
      'skip',
      new ParseIntPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    skip: number = 0,
    @Query(
      'limit',
      new ParseIntPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    limit: number = 10,
    @Query('searchQuery') searchQuery?: string,
    @Query('selectedGeo') selectedGeo?: string,
  ): Promise<GeoProfileListResponseDto> {
    return this.geoProfileService.findAllByUser(
      user._id,
      skip,
      limit,
      searchQuery,
      selectedGeo,
    );
  }

  @Delete(':profileId')
  async delete(
    @Param('profileId') profileId: string,
  ): Promise<void> {
    return this.geoProfileService.deleteGeoProfile(profileId);
  }
}
