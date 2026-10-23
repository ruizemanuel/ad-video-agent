// The root layout every page of the app sits in: the header with the brand and the home's sections, the fonts and the
// design tokens (globals.css). next/font downloads the fonts when the app is compiled and serves them from the app's
// own origin, so a browser never asks Google for them.
import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND, NAV } from '../site/copy';
import './globals.css';

const serif = Instrument_Serif({ weight: '400', subsets: ['latin'], variable: '--font-serif' });
const sans = IBM_Plex_Sans({ weight: ['400', '500', '600'], subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ weight: ['400', '500'], subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: BRAND,
  description: 'Paste your site’s URL, pay with your wallet and get a 9:16 video ad made from your real product.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              {/* A 9:16 frame: the format of every video the service makes. */}
              <i aria-hidden="true" />
              {BRAND}
            </Link>
            <nav className="site-nav" aria-label="Sections">
              {NAV.map(({ href, label }) => (
                <Link key={href} href={href}>
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
