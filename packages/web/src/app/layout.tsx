// The root layout every page of the app sits in. The pages are plain documents for now; the order page for people
// brings its own design.
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', lineHeight: 1.6, color: '#1a1a1a', background: '#fff' }}>{children}</body>
    </html>
  );
}
