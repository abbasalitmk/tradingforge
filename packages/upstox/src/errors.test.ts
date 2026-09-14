import { describe, it, expect } from 'vitest';
import { classify, UpstoxError } from './errors.ts';

/** Verbatim body captured from api.upstox.com on 2026-09-14. */
const STATIC_IP_BODY = {
  status: 'error',
  errors: [{
    errorCode: 'UDAPI1221',
    message: 'The API you are trying to access is permitted only when requested from the static IP configured in your account.',
    propertyPath: null, invalidValue: null,
    error_code: 'UDAPI1221', property_path: null, invalid_value: null,
  }],
};

describe('classify — real Upstox responses', () => {
  it('recognises UDAPI1221 as a static-IP problem, not a token problem', () => {
    const e = classify(401, STATIC_IP_BODY);
    // This distinction matters operationally: mistaking it for TOKEN_INVALID
    // would send the engine into a pointless re-auth loop while the real fix
    // is allowlisting the IP.
    expect(e.kind).toBe('STATIC_IP_REQUIRED');
    expect(e.code).toBe('UDAPI1221');
    expect(e.shouldHalt).toBe(true);
    expect(e.retryable).toBe(false);
  });

  it('treats a bare 401 with no code as an invalid token', () => {
    expect(classify(401, { status: 'error', errors: [] }).kind).toBe('TOKEN_INVALID');
  });

  it('recognises UDAPI100016 as an expired token', () => {
    const e = classify(401, { errors: [{ errorCode: 'UDAPI100016', message: 'Invalid credentials' }] });
    expect(e.kind).toBe('TOKEN_INVALID');
    expect(e.shouldHalt).toBe(true);
  });

  it('maps 423 to the funds-API maintenance window', () => {
    expect(classify(423, null).kind).toBe('MAINTENANCE');
  });

  it('maps 429 to rate limited, and marks it retryable', () => {
    const e = classify(429, null);
    expect(e.kind).toBe('RATE_LIMITED');
    expect(e.retryable).toBe(true);
    expect(e.shouldHalt).toBe(false);
  });

  it('maps 5xx to retryable server errors', () => {
    for (const s of [500, 502, 503]) expect(classify(s, null).retryable).toBe(true);
  });

  it('maps 4xx to non-retryable bad requests', () => {
    const e = classify(400, { errors: [{ errorCode: 'UDAPI1000', message: 'bad input' }] });
    expect(e.kind).toBe('BAD_REQUEST');
    expect(e.retryable).toBe(false);
  });

  it('survives a null or malformed body without throwing', () => {
    expect(() => classify(500, null)).not.toThrow();
    expect(() => classify(500, 'not json')).not.toThrow();
    expect(() => classify(500, { unexpected: true })).not.toThrow();
  });
});

describe('halt semantics', () => {
  it('halting failures are never retryable — retrying cannot fix them', () => {
    for (const kind of ['STATIC_IP_REQUIRED', 'TOKEN_INVALID'] as const) {
      const e = new UpstoxError(kind, 'x');
      expect(e.shouldHalt).toBe(true);
      expect(e.retryable).toBe(false);
    }
  });
  it('transient failures retry and do not halt', () => {
    for (const kind of ['RATE_LIMITED', 'SERVER_ERROR', 'NETWORK', 'TIMEOUT'] as const) {
      const e = new UpstoxError(kind, 'x');
      expect(e.retryable).toBe(true);
      expect(e.shouldHalt).toBe(false);
    }
  });
});
