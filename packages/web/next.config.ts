import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

/**
 * On every page and every answer of the API: nothing may frame the service (the old header and the CSP directive that
 * replaced it), a type is never guessed from the content, and no address goes out as a referrer: an order's page is its
 * link, and the link is the credential. Not a whole Content-Security-Policy: only its frame-ancestors.
 */
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

// @app/core ships TypeScript sources, so Next compiles it with the app. withWorkflow builds the durable flows.
const nextConfig: NextConfig = {
  transpilePackages: ['@app/core'],
  async headers() {
    // `/:path*` takes the root too.
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default withWorkflow(nextConfig);
