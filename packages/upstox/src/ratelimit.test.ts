import { describe, it, expect } from 'vitest';
import { FixedClock } from '@tradeforger/core';
import { RateLimiter, ORDER_LIMITS, STANDARD_LIMITS } from './ratelimit.ts';

const clock = () => new FixedClock(new Date('2026-09-14T04:30:00Z'));

describe('order limiter — 10/sec', () => {
  it('allows exactly 10 in the first second', () => {
    const c = clock();
    const l = new RateLimiter(ORDER_LIMITS, c);
    for (let i = 0; i < 10; i++) {
      expect(l.delayMs()).toBe(0);
      l.record();
    }
    expect(l.delayMs()).toBeGreaterThan(0);
  });

  it('recovers once the oldest hit ages out of the window', () => {
    const c = clock();
    const l = new RateLimiter(ORDER_LIMITS, c);
    for (let i = 0; i < 10; i++) l.record();
    expect(l.delayMs()).toBeGreaterThan(0);
    c.advance(1001);
    expect(l.delayMs()).toBe(0);
  });

  it('enforces the per-minute ceiling across many seconds', () => {
    const c = clock();
    const l = new RateLimiter(ORDER_LIMITS, c);
    // 50 seconds x 10/sec = 500, the per-minute cap.
    for (let s = 0; s < 50; s++) {
      for (let i = 0; i < 10; i++) l.record();
      c.advance(1000);
    }
    expect(l.stats().lastMinute).toBe(500);
    expect(l.delayMs()).toBeGreaterThan(0);
  });
});

describe('the order bucket is shared across all order operations', () => {
  it('place/modify/cancel/GTT together hit the same 10/sec ceiling', () => {
    const c = clock();
    const shared = new RateLimiter(ORDER_LIMITS, c);
    // Four different operation types, ten calls total.
    for (const _op of ['place', 'modify', 'cancel', 'gtt', 'place', 'modify', 'cancel', 'gtt', 'place', 'modify']) {
      expect(shared.delayMs()).toBe(0);
      shared.record();
    }
    // An eleventh must wait — this is the bug that four separate limiters
    // would miss, each believing it was compliant.
    expect(shared.delayMs()).toBeGreaterThan(0);
  });
});

describe('standard limiter — 50/sec', () => {
  it('is five times more permissive than the order bucket', () => {
    const c = clock();
    const l = new RateLimiter(STANDARD_LIMITS, c);
    for (let i = 0; i < 50; i++) l.record();
    expect(l.delayMs()).toBeGreaterThan(0);
    expect(l.stats().lastSecond).toBe(50);
  });
});
