export const BROWSER_ARGUMENTS = (
  proxy: string,
  locale: string,
  timeZone: string
) => {
  return [
    proxy,
    `--lang=${locale}`,
    `--timezone=${timeZone}`,
    "--disable-web-security",
    "--allow-running-insecure-content",
    "--ignore-certificate-errors",
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI",
    "--disable-ipc-flooding-protection",
  ];
};
