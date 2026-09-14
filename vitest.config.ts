import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@tradeforger/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@tradeforger/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@tradeforger/upstox': new URL('./packages/upstox/src/index.ts', import.meta.url).pathname,
      '@tradeforger/broker': new URL('./packages/broker/src/index.ts', import.meta.url).pathname,
      '@tradeforger/risk': new URL('./packages/risk/src/index.ts', import.meta.url).pathname,
      '@tradeforger/safety': new URL('./packages/safety/src/index.ts', import.meta.url).pathname,
    },
  },
});
