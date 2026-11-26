/**
 * Injectable clock.
 *
 * Every time-dependent rule — session windows, square-off deadlines, feed
 * staleness, breaker cooldowns — reads time through this. Tests drive a
 * FixedClock so a "15:05 square-off" case does not require waiting until 15:05,
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
  /** Strategies signal from here — the opening auction's first minutes are noise. */
  ENTRY_START: HHMM(9, 20),
  /** Strategies stop signalling here; too little runway to reach a target. */
  ENTRY_END: HHMM(14, 45),
  /** Pending (unfilled) entry orders are cancelled from here. */
  CANCEL_PENDING: HHMM(15, 0),
  /**
   * Unconditional flatten for intraday product — clear of the closing auction
   * session, where continuous trading stops and stop-loss orders are refused,
   * and of the broker's own auto square-off.
   */
  SQUARE_OFF: HHMM(15, 5),
  /** Exchange close. */
  CLOSE: HHMM(15, 30),
  /** Upstox funds API returns 423 in this window. */
  MAINTENANCE_START: HHMM(0, 0),
  MAINTENANCE_END: HHMM(5, 30),
} as const;

/** Seconds since IST midnight — entry windows are bounded to the second. */
export function istSeconds(d: Date): number {
  return istMinutes(d) * 60 + d.getUTCSeconds();
}

const HHMMSS = (h: number, m: number, s = 0): number => (h * 60 + m) * 60 + s;

/**
 * When autonomous entries may be placed, both ends inclusive. Strategies signal
 * 09:20–14:45 (what they were validated on); execution narrows that to the
 * morning prime and the afternoon momentum sessions, skipping the opening
 * volatility (09:15–09:29:59) and the midday chop (11:30:01–13:29:59).
 *
 * The morning starts at 09:30, not the often-quoted 09:45: over 12 months of
 * 5-minute data (19 NSE stocks), entries at 09:30–09:45 did better than any
 * later slot, and 09:45–10:30 was the worst of the day.
 */
export const ENTRY_SESSIONS = {
  MORNING: { from: HHMMSS(9, 30), to: HHMMSS(11, 30), label: '09:30–11:30' },
  AFTERNOON: { from: HHMMSS(13, 30), to: HHMMSS(14, 45), label: '13:30–14:45' },
} as const;
export type EntrySession = keyof typeof ENTRY_SESSIONS;

/** The entry session this moment falls in, or null when entries are blocked. */
export function entrySession(d: Date): EntrySession | null {
  const s = istSeconds(d);
  for (const k of Object.keys(ENTRY_SESSIONS) as EntrySession[]) {
    if (s >= ENTRY_SESSIONS[k].from && s <= ENTRY_SESSIONS[k].to) return k;
  }
  return null;
}

/** Why entries are blocked right now, or null inside an entry session. */
export function entryBlockReason(d: Date): string | null {
  if (entrySession(d)) return null;
  const s = istSeconds(d);
  if (s < HHMMSS(9, 15)) return 'before market open';
  if (s < ENTRY_SESSIONS.MORNING.from) return 'opening volatility (09:15–09:29)';
  if (s < ENTRY_SESSIONS.AFTERNOON.from) return 'midday chop (11:30–13:29)';
  return 'after the 14:45 entry cut-off';
}
