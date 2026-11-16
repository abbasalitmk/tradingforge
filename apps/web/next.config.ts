import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Disable immutable static assets so Vercel can deploy preview outputs without
  // failing on preview comments toolbar patching.
  supportsImmutableAssets: false,
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
