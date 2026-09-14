/**
 * Injectable clock.
 *
 * Every time-dependent rule — session windows, square-off deadlines, feed
 * staleness, breaker cooldowns — reads time through this. Tests drive a
 * FixedClock so a "15:10 square-off" case does not require waiting until 15:10,
 * and the replay harness can run a session at 100x with identical behaviour.
 */
export interface Clock {
  now(): Date;
  /** Epoch milliseconds. */
  ms(): number;
}

export const SystemClock: Clock = {
  now: () => new Date(),
  ms: () => Date.now(),
};

export class FixedClock implements Clock {
  private t: Date;

  constructor(t: Date) {
    this.t = t;
  }

  now(): Date {
    return new Date(this.t);
  }
  ms(): number {
    return this.t.getTime();
  }
  set(t: Date): void {
    this.t = t;
  }
  advance(msDelta: number): void {
    this.t = new Date(this.t.getTime() + msDelta);
  }
}

const IST_OFFSET_MIN = 330; // UTC+05:30, no DST

/** Minutes since IST midnight. The exchange runs on IST; the host may not. */
export function istMinutes(d: Date): number {
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (utcMin + IST_OFFSET_MIN) % (24 * 60);
}

export function istHHMM(d: Date): string {
  const m = istMinutes(d);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** IST calendar date as YYYY-MM-DD — the key every daily limit resets on. */
export function istDateKey(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export const HHMM = (h: number, m: number): number => h * 60 + m;

/** NSE equity session and the safety windows layered on top of it. */
export const SESSION = {
  /** Exchange open. */
  OPEN: HHMM(9, 15),
  /** No entries before this — the opening auction's first minutes are noise. */
  ENTRY_START: HHMM(9, 20),
  /** No new entries after this; too little runway to reach a target. */
  ENTRY_END: HHMM(14, 45),
  /** Unconditional flatten for intraday product. */
  SQUARE_OFF: HHMM(15, 10),
  /** Exchange close. */
  CLOSE: HHMM(15, 30),
  /** Upstox funds API returns 423 in this window. */
  MAINTENANCE_START: HHMM(0, 0),
  MAINTENANCE_END: HHMM(5, 30),
} as const;
