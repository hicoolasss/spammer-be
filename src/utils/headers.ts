export const HEADERS = (locale: string, userAgent: string, url: string): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': locale,
    Referer: 'http://m.facebook.com/',
    'User-Agent': userAgent,
    "Content-Security-Policy":
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' *.facebook.com *.fbcdn.net; object-src 'none'; base-uri 'self'",
    "X-Frame-Options": "SAMEORIGIN",
    "X-XSS-Protection": "1; mode=block",
    "X-Content-Type-Options": "nosniff",
  };

  if (!url || !url.includes('affid=')) {
    headers["X-Requested-With"] = "com.facebook.katana";
  }

  return headers;
};
