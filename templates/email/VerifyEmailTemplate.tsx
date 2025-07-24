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

export function VerifyEmailTemplate(link: string) {
  return (
    <Html>
      <Head />
      <Preview>Verify Email</Preview>
      <Font
        fontFamily="Roboto"
        fallbackFontFamily="Verdana"
        webFont={{
          url: 'https://fonts.gstatic.com/s/roboto/v27/KFOmCnqEu92Fr1Mu4mxKKTU1Kg.woff2',
          format: 'woff2',
        }}
        fontWeight={400}
        fontStyle="normal"
      />
      <Tailwind>
        <Body className="bg-white my-auto mx-auto font-sans px-2">
          {/* TODO */}
          <Text>{{ link }}</Text>
        </Body>
      </Tailwind>
    </Html>
  );
}
