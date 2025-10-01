import { CountryCode } from '@enums';
import { IGeoRegionWithProxy, IProxyInfo } from '@interfaces';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { LogWrapper } from '@utils';
import { Model } from 'mongoose';

import { GeoRegions } from './geo-regions.schema';

@Injectable()
export class GeoRegionsService implements OnModuleInit {
  private readonly logger = new LogWrapper(GeoRegionsService.name);

  private readonly AUTO_FILL_REGIONS = process.env.AUTO_FILL_REGIONS !== 'false';

  constructor(
    @InjectModel(GeoRegions.name)
    private readonly GeoRegionsModel: Model<GeoRegions>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.AUTO_FILL_REGIONS) {
      this.logger.info('Auto-fill regions disabled via AUTO_FILL_REGIONS=false');
      return;
    }

    try {
      this.logger.info('GeoRegionsService initializing - checking for missing geo regions...');
      const result = await this.fillRegions();

      if (result.success) {
        this.logger.info(`GeoRegionsService initialization complete: ${result.message}`);
        if (result.createdCount > 0) {
          this.logger.info(`Created ${result.createdCount} new geo regions during initialization`);
        }
      } else {
        this.logger.warn(`GeoRegionsService initialization warning: ${result.message}`);
      }
    } catch (error) {
      this.logger.error(`Error during GeoRegionsService initialization: ${error}`);
      // Don't throw here to avoid preventing the application from starting
    }
  }

  async getGeoProxy(countryCode: CountryCode): Promise<IProxyInfo> {
    const geoProxy = await this.GeoRegionsModel.findOne({
      name: countryCode,
    }).exec();

    if (geoProxy && geoProxy.host && geoProxy.port && geoProxy.username && geoProxy.password) {
      return geoProxy;
    }

    const defaultProxy = await this.GeoRegionsModel.findOne({
      countryCode: CountryCode.ALL,
    }).exec();

    if (
      defaultProxy &&
      defaultProxy.host &&
      defaultProxy.port &&
      defaultProxy.username &&
      defaultProxy.password
    ) {
      return defaultProxy;
    }

    if (
      process.env.PROXY_HOST ||
      parseInt(process.env.PROXY_PORT, 10) ||
      process.env.PROXY_USERNAME ||
      process.env.PROXY_PASSWORD
    ) {
      this.logger.error('No active proxy found and no environment proxy set.');
      throw new Error('No active proxy found and no environment proxy set.');
    }

    const envProxy = {
      host: process.env.PROXY_HOST,
      port: parseInt(process.env.PROXY_PORT, 10),
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
      countryCode: CountryCode.ALL,
    };

    return envProxy;
  }

  async getGeoAll(): Promise<IGeoRegionWithProxy[]> {
    try {
      return await this.GeoRegionsModel.find().lean();
    } catch (error) {
      this.logger.error(`Error in getGeoAll: ${error}`);
      throw error;
    }
  }

  async getOneByCountryCode(countryCode: CountryCode): Promise<IGeoRegionWithProxy> {
    try {
      const region = await this.GeoRegionsModel.findOne({ countryCode }).lean();

      if (!region) {
        throw new Error(`Region not found for country code: ${countryCode}`);
      }

      return region;
    } catch (error) {
      this.logger.error(`Error in getOneByCountryCode (countryCode: ${countryCode}): ${error}`);
      throw error;
    }
  }

  async editGeoRegions(regions: CountryCode[], proxySettings: IProxyInfo): Promise<void> {
    try {
      if (!regions) {
        throw new Error('Regions parameter is required');
      }

      if (!Array.isArray(regions)) {
        throw new Error(
          `Invalid regions parameter: expected array, got ${typeof regions} (${JSON.stringify(regions)})`,
        );
      }

      if (regions.length === 0) {
        throw new Error('Regions array cannot be empty');
      }

      for (const region of regions) {
        if (!Object.values(CountryCode).includes(region)) {
          throw new Error(`Invalid country code: ${region}`);
        }
      }

      await Promise.all(regions.map((region) => this.editGeoRegionProxy(region, proxySettings)));
    } catch (error) {
      this.logger.error(`Error in editGeoRegions (regions: ${JSON.stringify(regions)}): ${error}`);
      throw error;
    }
  }

  private async getIdByRegion(regionName: string): Promise<string> {
    const region = await this.GeoRegionsModel.findOne({
      name: regionName,
    }).lean();

    if (!region) {
      throw new Error(`Region not found: ${regionName}`);
    }

    return region._id.toString();
  }

  private async editGeoRegionProxy(
    name: CountryCode,
    proxySettings: IProxyInfo,
  ): Promise<{ id: string; code: CountryCode }> {
    try {
      const regionId = await this.getIdByRegion(name);
      const updateData: Record<string, unknown> = {};

      if (proxySettings) {
        Object.entries(proxySettings).forEach(([key, value]) => {
          if (value !== undefined) {
            updateData[key] = value;
          }
        });
      }

      await this.GeoRegionsModel.findByIdAndUpdate(regionId, updateData);

      return { id: regionId, code: name };
    } catch (error) {
      this.logger.error(`Error in editGeoRegionProxyOnly (region: ${name}): ${error}`);
      throw error;
    }
  }

  private async fillRegions(): Promise<{
    success: boolean;
    message: string;
    createdCount: number;
  }> {
    try {
      const allCountryCodes = Object.values(CountryCode);
      this.logger.info(`Starting to fill regions for ${allCountryCodes.length} country codes`);

      const existingRegions = await this.GeoRegionsModel.find().lean();
      const existingRegionCodes = new Set(existingRegions.map(({ name }) => name));

      const regionsToCreate = allCountryCodes
        .filter((code) => !existingRegionCodes.has(code))
        .map((code) => ({
          name: code,
        }));

      if (regionsToCreate.length === 0) {
        this.logger.info('All regions already exist, nothing to create');
        return {
          success: true,
          message: 'All regions already exist',
          createdCount: 0,
        };
      }

      const createdRegions = await this.GeoRegionsModel.insertMany(regionsToCreate);

      this.logger.info(
        `Successfully created ${createdRegions.length} new geo regions: ${createdRegions.map((r) => r.name).join(', ')}`,
      );

      return {
        success: true,
        message: `Created ${createdRegions.length} new geo regions`,
        createdCount: createdRegions.length,
      };
    } catch (error) {
      this.logger.error(`Error in fillRegions: ${error}`);
      throw error;
    }
  }
}
