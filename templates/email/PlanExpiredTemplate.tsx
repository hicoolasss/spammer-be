import {
  Body,
  Font,
  Head,
  Html,
  Preview,
  Tailwind,
} from '@react-email/components';
import * as React from 'react';

export function PlanExpiredTemplate(name: string) {
  return (
    <Html>
      <Head />
      <Preview>
        Last Chance! Your <strong>{name}</strong> Subscription Ends Tomorrow,
        don't miss out on your discount!
      </Preview>
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
        </Body>
      </Tailwind>
    </Html>
  );
}
