/** Upstox error codes we branch on. Discovered by live probing, 2026-09-14. */
export const UPSTOX_ERRORS = {
  /** Endpoint requires the account's configured static IP. */
  STATIC_IP_REQUIRED: 'UDAPI1221',
  /** Token expired or invalid. */
  INVALID_CREDENTIALS: 'UDAPI100016',
} as const;

export type UpstoxFailureKind =
  | 'STATIC_IP_REQUIRED'
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'MAINTENANCE'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'TIMEOUT';

export class UpstoxError extends Error {
  readonly kind: UpstoxFailureKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(
    kind: UpstoxFailureKind,
    message: string,
    status?: number,
    code?: string,
    body?: unknown,
  ) {
    super(message);
    this.name = 'UpstoxError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** Retrying these can succeed; the rest need intervention. */
  get retryable(): boolean {
    return this.kind === 'RATE_LIMITED' || this.kind === 'SERVER_ERROR'
      || this.kind === 'NETWORK' || this.kind === 'TIMEOUT';
  }

  /**
   * Whether this failure should halt trading rather than just fail the call.
   * A missing static IP or an invalid token means EVERY subsequent trading
   * call will fail too — continuing would just burn the reject-rate breaker.
   */
  get shouldHalt(): boolean {
    return this.kind === 'STATIC_IP_REQUIRED' || this.kind === 'TOKEN_INVALID';
  }
}

interface UpstoxErrorBody {
  errors?: Array<{ errorCode?: string; message?: string }>;
}

export function classify(status: number, body: unknown): UpstoxError {
  const errs = (body as UpstoxErrorBody | null)?.errors ?? [];
  const code = errs[0]?.errorCode;
  const msg = errs[0]?.message ?? `HTTP ${status}`;

  if (code === UPSTOX_ERRORS.STATIC_IP_REQUIRED) {
    return new UpstoxError('STATIC_IP_REQUIRED', msg, status, code, body);
  }
  if (code === UPSTOX_ERRORS.INVALID_CREDENTIALS || status === 401) {
    return new UpstoxError('TOKEN_INVALID', msg, status, code, body);
  }
  if (status === 429) return new UpstoxError('RATE_LIMITED', msg, status, code, body);
  // 423 Locked: funds API during the 00:00–05:30 IST maintenance window.
  if (status === 423) return new UpstoxError('MAINTENANCE', msg, status, code, body);
  if (status >= 500) return new UpstoxError('SERVER_ERROR', msg, status, code, body);
  return new UpstoxError('BAD_REQUEST', msg, status, code, body);
}
