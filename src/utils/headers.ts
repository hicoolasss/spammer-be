export const HEADERS = (locale: string) => ({
  site: "fb", 
  Referer: "https://l.facebook.com/",
  "Accept-Language": locale,
  "X-Requested-With": "com.facebook.katana",
  "Content-Security-Policy":
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' *.facebook.com *.fbcdn.net; object-src 'none'; base-uri 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "X-XSS-Protection": "1; mode=block",
  "X-Content-Type-Options": "nosniff",
});
