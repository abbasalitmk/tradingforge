import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; the market routes import them.
  transpilePackages: [
    '@tradeforger/core',
    '@tradeforger/indicators',
    '@tradeforger/strategy',
    '@tradeforger/fno',
    '@tradeforger/upstox',
    '@tradeforger/ai',
    '@tradeforger/backtest',
    '@tradeforger/data',
  ],
  async headers() {
    return [
      {
        // Webhook + API endpoints must never be cached or indexed.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default config;
