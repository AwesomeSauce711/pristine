import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.GITHUB_PAGES === '1' ? '/pristine' : undefined,
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
