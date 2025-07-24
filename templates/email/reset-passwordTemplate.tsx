import {
  Body,
  Font,
  Head,
  Html,
  Preview,
  Tailwind,
  Text,
} from '@react-email/components';
import * as React from 'react';

export function ResetPasswordTemplate(link: string) {
  return (
    <Html>
      <Head />
      <Preview>Reset your password - Secure your marketing dashboard</Preview>
      <Font
        fontFamily="Inter"
        fallbackFontFamily="Arial"
        webFont={{
          url: 'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2',
          format: 'woff2',
        }}
        fontWeight={400}
        fontStyle="normal"
      />
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          {/* TODO */}
          <Text>{{ link }}</Text>
        </Body>
      </Tailwind>
    </Html>
  );
}
