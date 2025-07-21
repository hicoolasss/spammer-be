export const HEADERS = (locale: string) => ({
  site: "fb", 
  Referer: "https://l.facebook.com/",
  "Accept-Language": locale,
  "X-Requested-With": "com.facebook.katana",
  "HTTP_SEC_CH_UA": '"Not)A;Brand";v="8", "Chromium";v="138", "Android WebView";v="138"',
  "HTTP_SEC_CH_UA_MOBILE": '?1',
  "HTTP_SEC_CH_UA_PLATFORM": '"Android"',
  "Content-Security-Policy":
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' *.facebook.com *.fbcdn.net; object-src 'none'; base-uri 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "X-XSS-Protection": "1; mode=block",
  "X-Content-Type-Options": "nosniff",
});
