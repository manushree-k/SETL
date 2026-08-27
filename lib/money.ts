// Money primitives for Setl.
//
// THE ONE RULE: every amount in this system is an integer number of paise.
// Never rupees, never a float, never a fraction. There is no `parseFloat`
// in this file, no `Number()` applied to a money string, and no `/` or `*`
// used to compute a money value outside `roundHalfUp`.
//
// JavaScript has no integer type — every number is an IEEE-754 float64.
// So "integer arithmetic only" cannot mean "avoid the number type"; it
// means every intermediate value must be an exact whole number and a
// fraction must never come into existence. Floats represent integers
// exactly up to 2^53; they only lose precision once a fractional part
// appears. This file is written so one never does.

declare const paiseBrand: unique symbol;

/**
 * An integer count of paise. ₹1,000.00 is `100000`.
 *
 * This is a "branded" type: at runtime it is just a number, but TypeScript
 * treats it as distinct, so a plain number (which might be rupees, or a
 * float) cannot be passed where Paise is expected without going through
 * `toPaise` / `parseMoney`. That turns a whole class of unit-confusion bug
 * into a compile error.
 */
export type Paise = number & { readonly [paiseBrand]: true };

/** Largest amount we allow: keeps every intermediate inside 2^53. */
const MAX_PAISE = Number.MAX_SAFE_INTEGER;

/**
 * Assert a value is a safe integer and tag it as Paise.
 * Throws rather than truncating — a float reaching here is a bug upstream.
 */
export function toPaise(value: number): Paise {
  if (!Number.isInteger(value)) {
    throw new Error(
      `Amount must be an integer number of paise, received ${value}. ` +
        `A fractional value here means rupees leaked in somewhere, or a float was used.`
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Amount ${value} exceeds the safe integer range.`);
  }
  return value as Paise;
}

/**
 * Divide two integers and round half away from zero, using integer
 * arithmetic only.
 *
 * The division is passed UNPERFORMED, as a numerator and denominator, so
 * the caller never has to create a fraction:
 *
 *     fee = roundHalfUp(amount * 200, 10000)     // 200 bps
 *     gst = roundHalfUp(fee * 1800, 10000)       // 18% GST on the fee
 *
 * "Half up" here means away from zero in both directions:
 * `roundHalfUp(5, 2)` is 3 and `roundHalfUp(-5, 2)` is -3. Negative
 * amounts are real in this system (refunds, disputes, debit adjustments),
 * so rounding must be symmetric rather than biased toward +infinity.
 */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator)) {
    throw new Error(`roundHalfUp numerator must be a safe integer, received ${numerator}.`);
  }
  if (!Number.isSafeInteger(denominator)) {
    throw new Error(`roundHalfUp denominator must be a safe integer, received ${denominator}.`);
  }
  if (denominator === 0) {
    throw new Error('roundHalfUp denominator must not be zero.');
  }

  // Normalize so the denominator is positive; the sign of the result is
  // then carried entirely by the numerator.
  let n = numerator;
  let d = denominator;
  if (d < 0) {
    n = -n;
    d = -d;
  }

  const r = n % d; // remainder; sign follows n; |r| < d
  // (n - r) is by construction an exact multiple of d, so this quotient is
  // a whole number and IEEE division returns it exactly. This is integer
  // division built out of `%` and `-`, with no fractional intermediate.
  const q = (n - r) / d;

  const absR = r < 0 ? -r : r;

  // Is the remainder at least half the denominator?
  //   absR >= d - absR   is equivalent to   2 * absR >= d
  // but avoids the multiply, which could overflow past MAX_SAFE_INTEGER
  // for a large denominator. Both sides stay exact integers.
  if (absR >= d - absR) {
    return q + (n < 0 ? -1 : 1); // away from zero
  }
  return q;
}

/** Matches a bare money string after symbols and separators are stripped. */
const MONEY_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a money string into integer paise.
 *
 *     parseMoney('₹1,000.00')  ->  100000
 *     parseMoney('-₹1,000.00') -> -100000
 *     parseMoney('1000')       ->  100000
 *     parseMoney('1000.005')   ->  throws
 *
 * More than two decimal places is a DATA ERROR, not a rounding
 * opportunity: sub-paise precision in a settlement file means the file is
 * wrong, and silently rounding it would hide that. It throws.
 *
 * Conversion goes through BigInt rather than `Number()`. BigInt cannot
 * represent a fraction at all, so the absence of floating point here is
 * structural rather than something a reader has to verify by eye.
 */
export function parseMoney(s: string): Paise {
  if (typeof s !== 'string') {
    throw new Error(`parseMoney expects a string, received ${typeof s}.`);
  }

  // Strip the rupee symbol, thousands separators and all whitespace.
  // Everything that survives must be sign + digits + at most 2 decimals.
  const cleaned = s.replace(/[₹,\s]/g, '');

  if (cleaned === '') {
    throw new Error(`Cannot parse money from an empty string (received ${JSON.stringify(s)}).`);
  }

  const match = MONEY_PATTERN.exec(cleaned);
  if (!match) {
    // Give the common cause its own message — this is the one a bad
    // settlement file actually trips, and a vague error costs debugging time.
    if (/^-?\d+\.\d{3,}$/.test(cleaned)) {
      throw new Error(
        `Money value ${JSON.stringify(s)} has more than 2 decimal places. ` +
          `Sub-paise precision is a data error, not a rounding opportunity.`
      );
    }
    throw new Error(`Cannot parse money from ${JSON.stringify(s)}.`);
  }

  const [, sign, rupeeDigits, fractionDigits = ''] = match;

  // Pad '5' -> '50' so a single decimal digit means tenths of a rupee.
  const paiseDigits = fractionDigits.padEnd(2, '0');

  const total = BigInt(rupeeDigits) * 100n + BigInt(paiseDigits);
  const signed = sign === '-' ? -total : total;

  if (signed > BigInt(MAX_PAISE) || signed < -BigInt(MAX_PAISE)) {
    throw new Error(`Money value ${JSON.stringify(s)} exceeds the safe integer range.`);
  }

  // Safe: `signed` is a whole number already checked to be within 2^53,
  // so this conversion is exact.
  return Number(signed) as Paise;
}

/**
 * Format integer paise as Indian-format rupees.
 *
 *     formatPaise(100000)   ->  '₹1,000.00'
 *     formatPaise(10000000) ->  '₹1,00,000.00'
 *     formatPaise(-100000)  ->  '-₹1,000.00'
 *
 * Indian digit grouping is not uniform: the last three digits group
 * together, then every two digits above that (1,00,00,000 = one crore).
 * Done on the digit STRING rather than via Intl.NumberFormat, because
 * Intl operates on floats and this must stay exact.
 */
export function formatPaise(p: Paise | number): string {
  if (!Number.isInteger(p)) {
    throw new Error(`formatPaise expects integer paise, received ${p}.`);
  }

  const negative = p < 0;
  const abs = negative ? -p : p;

  // Integer split into rupees and paise — no division producing a fraction.
  const fraction = abs % 100;
  const rupees = (abs - fraction) / 100;

  const rupeeDigits = String(rupees);
  const fractionDigits = String(fraction).padStart(2, '0');

  let grouped: string;
  if (rupeeDigits.length <= 3) {
    grouped = rupeeDigits;
  } else {
    const lastThree = rupeeDigits.slice(-3);
    const rest = rupeeDigits.slice(0, -3);
    // Group the remaining digits in twos, from the right.
    const restGrouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${restGrouped},${lastThree}`;
  }

  return `${negative ? '-' : ''}₹${grouped}.${fractionDigits}`;
}
