import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.GITHUB_PAGES === '1' ? '/pristine' : undefined,
  images: { unoptimized: true },
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BASE_PATH: process.env.GITHUB_PAGES === '1' ? '/pristine' : '' },
};

export default nextConfig;
