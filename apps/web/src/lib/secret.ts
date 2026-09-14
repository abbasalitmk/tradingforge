import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of a path secret.
 *
 * Length is compared first and non-constant-time, which is fine: the length of
 * the expected secret is a fixed, public design constant (64 hex chars), so it
 * leaks nothing an attacker does not already know.
 */
export function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}
