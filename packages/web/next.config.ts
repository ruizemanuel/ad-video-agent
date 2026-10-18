import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

// @app/core ships TypeScript sources, so Next compiles it with the app. withWorkflow builds the durable flows.
const nextConfig: NextConfig = {
  transpilePackages: ['@app/core'],
};

export default withWorkflow(nextConfig);
