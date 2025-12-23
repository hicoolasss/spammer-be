import { IsAdminGuard } from '@_guards';
import { IGeoRegionWithProxy, IProxyInfo, IResponseMessage } from '@interfaces';
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { LogWrapper } from '@utils';

import { EditGeoDto } from './dto/edit-geo.dto';
import { GeoRegionsService } from './geo-regions.service';

@Controller('geo-regions')
@UseGuards(AuthGuard('jwt'))
export class GeoRegionsController {
  private readonly logger = new LogWrapper(GeoRegionsController.name);

  constructor(private readonly GeoRegionsService: GeoRegionsService) {}

  async getAll(): Promise<IGeoRegionWithProxy[] | IResponseMessage> {
    try {
      return await this.GeoRegionsService.getGeoAll();
    } catch (error) {
      this.logger.error(error);
      return { success: false, message: error.message };
    }
  }

  @Post('edit')
  @UseGuards(IsAdminGuard)
  async edit(@Body() body: EditGeoDto): Promise<IResponseMessage> {
    try {
      const { regions, username, password, port, host } = body;

      const proxySettings: IProxyInfo = {};
      if (username !== undefined) proxySettings.username = username;
      if (password !== undefined) proxySettings.password = password;
      if (port !== undefined) proxySettings.port = port;
      if (host !== undefined) proxySettings.host = host;

      await this.GeoRegionsService.editGeoRegions(regions, proxySettings);
      return { success: true };
    } catch (error) {
      this.logger.error(error);
      return { success: false, message: error.message };
    }
  }
}
