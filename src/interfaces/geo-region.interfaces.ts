import { CountryCode } from '@enums';

interface IGeoRegion {
  name: CountryCode;
}

export interface IProxyInfo {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export interface IGeoRegionWithProxy extends IGeoRegion, IProxyInfo {}

export interface IEditGeoDto extends IProxyInfo {
  names: CountryCode[];
}
