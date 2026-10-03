import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @mb/core ships TypeScript source; Turbopack transpiles workspace packages, this keeps webpack builds working too.
  transpilePackages: ['@mb/core'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
