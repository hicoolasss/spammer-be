export const BROWSER_ARGUMENTS = (
  proxy: string,
  locale: string,
  timeZone: string,
  options?: {
    disableWebSecurity?: boolean;
  },
) => {
  const args = [
    proxy,
    `--lang=${locale}`,
    `--timezone=${timeZone}`,
    "--allow-running-insecure-content",
    "--ignore-certificate-errors",
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
    "--disable-webrtc",
    "--disable-notifications",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-features=UserAgentClientHint",
    "--disable-features=ClientHintsPersist",
    "--disable-features=AcceptCHFrame",
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];

  if (options?.disableWebSecurity) {
    args.push("--disable-web-security");
  }

  return args;
};