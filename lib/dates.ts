// Date handling for Setl. Everything in this system happens in IST.
//
// India Standard Time is UTC+05:30 with NO daylight saving, which makes
// this far simpler than a general timezone problem: a fixed offset is
// enough, and we never need a timezone database.
//
// The technique used throughout: shift a UTC instant by +5:30 and then
// read it with the getUTC* methods. Those getters then report IST
// calendar fields. This avoids `toLocaleString` round-tripping (slow,
// locale-dependent) and avoids depending on the host machine's timezone,
// so results are identical on your laptop and on Vercel.

/** IST is UTC+05:30, year-round. */
const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

/**
 * Bank holidays observed for settlement purposes, as IST calendar dates.
 *
 * These are India's three NATIONAL holidays, which fall on fixed dates
 * every year and are certain. Variable-date festival holidays (Diwali,
 * Holi, Eid, and the state-specific ones) are deliberately omitted rather
 * than guessed: a wrong date here would silently shift settlement cycles
 * and corrupt the generated dataset, which is worse than a short list.
 *
 * The settlement cycle logic is therefore "weekends plus these dates" —
 * a deliberate, stated simplification. Extend this array to model a real
 * bank calendar; nothing else needs to change.
 */
export const HOLIDAYS: readonly string[] = [
  '2025-01-26', // Republic Day
  '2025-08-15', // Independence Day
  '2025-10-02', // Gandhi Jayanti
  '2026-01-26', // Republic Day
  '2026-08-15', // Independence Day
  '2026-10-02', // Gandhi Jayanti
  '2027-01-26', // Republic Day
  '2027-08-15', // Independence Day
  '2027-10-02', // Gandhi Jayanti
];

const HOLIDAY_SET = new Set(HOLIDAYS);

interface ISTParts {
  year: number;
  month: number; // 0-indexed, matching Date
  day: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

/** Read the IST calendar fields of an instant. */
function istParts(d: Date): ISTParts {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * Parse a timestamp into a Date, interpreting it in IST.
 *
 * - `'2026-04-15T10:30:00+05:30'` — explicit offset, honoured as given
 * - `'2026-04-15T10:30:00Z'`      — explicit UTC, honoured as given
 * - `'2026-04-15T10:30:00'`       — no offset, interpreted as IST
 * - `'2026-04-15'`                — date only, interpreted as IST midnight
 *
 * The naive cases matter: CSV exports frequently omit the offset, and
 * defaulting those to UTC (which `new Date()` does for date-only strings)
 * would shift every timestamp by 5.5 hours and move records across
 * settlement cycle boundaries.
 */
export function parseIST(input: string): Date {
  if (typeof input !== 'string') {
    throw new Error(`parseIST expects a string, received ${typeof input}.`);
  }

  const s = input.trim();
  if (s === '') {
    throw new Error('Cannot parse a date from an empty string.');
  }

  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);

  let normalized: string;
  if (hasExplicitOffset) {
    normalized = s;
  } else if (isDateOnly) {
    normalized = `${s}T00:00:00+05:30`;
  } else {
    normalized = `${s}+05:30`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Cannot parse a date from ${JSON.stringify(input)}.`);
  }
  return parsed;
}

/** Format an instant as its IST calendar date, `YYYY-MM-DD`. */
export function formatISTDate(d: Date): string {
  const { year, month, day } = istParts(d);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** The instant of IST midnight beginning the IST calendar day of `d`. */
export function istMidnight(d: Date): Date {
  const { year, month, day } = istParts(d);
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}

/**
 * True when the IST calendar day of `d` is a settlement business day:
 * not a Saturday, not a Sunday, and not in HOLIDAYS.
 */
export function isBusinessDay(d: Date): boolean {
  const { weekday } = istParts(d);
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAY_SET.has(formatISTDate(d));
}

/**
 * Add `n` business days to a date, skipping weekends and HOLIDAYS.
 *
 * Returns IST midnight of the resulting calendar day — settlement cycles
 * are day-grained, so the time of day is deliberately discarded.
 *
 * `n = 0` returns the same calendar day unchanged, even if that day is a
 * weekend or holiday. Negative `n` steps backwards. Counting starts from
 * the day AFTER the start date, so a Monday capture plus 2 business days
 * is Wednesday.
 */
export function addBusinessDays(date: Date, n: number): Date {
  if (!Number.isInteger(n)) {
    throw new Error(`addBusinessDays expects an integer day count, received ${n}.`);
  }

  let cursor = istMidnight(date);
  if (n === 0) return cursor;

  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);

  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + step * 24 * 60 * 60 * 1000);
    if (isBusinessDay(cursor)) {
      remaining -= 1;
    }
  }

  return cursor;
}

/** Razorpay's default payout cadence: capture + 2 business days. */
export const SETTLEMENT_CYCLE_BUSINESS_DAYS = 2;

/**
 * The settlement cycle date for a payment captured at `captureDate`:
 * T+2 business days, as IST midnight.
 */
export function settlementCycleDate(captureDate: Date): Date {
  return addBusinessDays(captureDate, SETTLEMENT_CYCLE_BUSINESS_DAYS);
}

/**
 * Whole IST calendar days between two instants (`b` minus `a`).
 * Used by the matching passes to score date proximity.
 */
export function daysBetweenIST(a: Date, b: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = istMidnight(b).getTime() - istMidnight(a).getTime();
  return Math.round(diff / msPerDay);
}
