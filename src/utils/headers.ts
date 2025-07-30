export const HEADERS = (locale: string, userAgent: string): Record<string, string> => ({
  Accept: 'application/json',
  'Accept-Language': locale,
  Referer: 'http://m.facebook.com/',
  site: 'fb',
  'User-Agent': userAgent,
});
