export function getLocaleOverrideScript(
  locale: string,
  timeZone: string,
): string {
  return `
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
      value: function () {
        return {
          locale: '${locale}',
          timeZone: '${timeZone}'
        };
      }
    });

    Object.defineProperty(navigator, 'language', {
      get: () => '${locale}'
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['${locale}']
    });
  `;
}
