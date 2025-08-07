import { CountryCode } from '@enums';

import { LogWrapper } from './LogWrapper';
import { validateCountryCodeMapping } from './success-indicators';

const logger = new LogWrapper('GeoTypes');

export function validateCountryCodeTypes(): void {
  const mappingValidation = validateCountryCodeMapping();

  if (mappingValidation.missingInLocaleSettings.length > 0) {
    logger.warn(
      '⚠️  Отсутствующие записи в LOCALE_SETTINGS:',
      mappingValidation.missingInLocaleSettings,
    );
  }

  if (mappingValidation.extraInLocaleSettings.length > 0) {
    logger.warn('⚠️  Лишние записи в LOCALE_SETTINGS:', mappingValidation.extraInLocaleSettings);
  }

  if (
    mappingValidation.missingInLocaleSettings.length === 0 &&
    mappingValidation.extraInLocaleSettings.length === 0
  ) {
    logger.info('✅ Все записи CountryCode корректно отображены в LOCALE_SETTINGS');
  }

  const countryCodes = Object.values(CountryCode);
  const invalidCodes = countryCodes.filter((code) => typeof code !== 'string');

  if (invalidCodes.length > 0) {
    logger.error('❌ Найдены некорректные значения CountryCode:', invalidCodes);
  } else {
    logger.info('✅ Все значения CountryCode являются строками');
  }

  const uniqueCodes = new Set(countryCodes);
  if (uniqueCodes.size !== countryCodes.length) {
    logger.error('❌ Найдены дублирующиеся значения в CountryCode');
  } else {
    logger.info('✅ Все значения CountryCode уникальны');
  }
}

export function validateTaskGeoTypes(taskGeo: string): boolean {
  const isValidCountryCode = Object.values(CountryCode).includes(taskGeo as CountryCode);

  if (!isValidCountryCode) {
    logger.warn(`⚠️  Гео "${taskGeo}" не найден в CountryCode enum`);
    return false;
  }

  return true;
}
