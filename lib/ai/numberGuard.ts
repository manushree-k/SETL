// The number guard. SETL_BLUEPRINT.md section 14.
//
// The mechanism that makes "the AI cannot invent financial facts" a
// demonstrable claim rather than a promise: walk the evidence bundle
// recursively, build an allowlist of every numeric value in every
// representation the model might plausibly write, extract every numeric
// token from the explanation, normalize each, and reject the whole
// explanation if any token isn't in the allowlist.
//
// Deliberate simplification, and why it's still faithful to the spec:
// after normalizing away formatting (₹, commas, decimal places, % signs),
// every one of the blueprint's own example string representations for one
// evidence value collapses to exactly ONE OF TWO numbers — paise or
// rupees for money ("₹4,820.00"/"4820.00"/"4,820" all parse to the same
// number, 4820; only the ₹482000-vs-4820 paise/rupee split is a genuinely
// different number), and ratio or percentage for a score (0.94 vs 94).
// So instead of generating and matching against a set of STRINGS, this
// file generates and matches against a set of NUMBERS — {value, value*100}
// for every bundle value found — which is equivalent after normalization
// and far simpler to get right. Dates are the one kind of value compared
// as normalized strings, not numbers, since "15 April" isn't a number at all.

const CARVE_OUT_NUMBERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18];
// Documented per section 14: small integers 0-10 (counting words like
// "two refunds" written as digits), plus the constants 18 (GST rate) and
// 2 (T+2 cycle) — 2 is already inside 0-10, kept explicit here anyway so
// this list reads the same as the blueprint's own wording, not a
// logically-deduplicated version that quietly drops a name.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_PATTERN = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-zA-Z]*\\.?';

const DATE_TOKEN_REGEX = new RegExp(
  `\\d{4}-\\d{2}-\\d{2}` + // 2026-04-15
    `|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}(?:\\s+\\d{4})?` + // 15 Apr / 15th April 2026
    `|\\d{1,2}\\/\\d{1,2}\\/\\d{4}`, // 15/04/2026
  'gi'
);

// ₹, optional sign (ASCII hyphen or the unicode minus '−' some formatted
// strings use), digit groups with optional commas, optional decimal,
// optional trailing %. Guarded on both sides against a letter, digit, or
// hyphen immediately touching the match, so a digit run embedded in an
// alphanumeric id (order_ref "KK-2026-04198", entity_id "rfnd_A1") is
// never mistaken for a standalone number the model wrote — those ids are
// themselves present in the bundle as opaque strings, not decomposed into
// their digit runs, so extracting "2026" out of one and rejecting it as
// an unlisted number would be a false positive, not a real hallucination.
// The lookbehind must block "preceded by a digit" too, not just letters —
// otherwise, once the true start of a hyphen-embedded run is correctly
// blocked, a plain global regex retry just resumes one character later
// (now preceded by a digit, not a letter) and matches a truncated suffix
// of the same id instead of failing outright.
const NUMERIC_TOKEN_REGEX = /(?<![a-zA-Z0-9-])₹?\s*[-−]?[\d,]+(?:\.\d+)?%?(?![a-zA-Z])/g;

function isMoneyLikeString(s: string): boolean {
  return /^[-−]?[\d,]+(?:\.\d{1,2})?$/.test(s.trim()) || /^₹[-−]?[\d,]+(?:\.\d{1,2})?$/.test(s.trim());
}

function isIsoDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/** Parse a formatted money string (₹4,820.00, -4820, 4,820) to paise. Returns null if unparseable. */
function parseMoneyLikeToPaise(s: string): number | null {
  const cleaned = s.trim().replace(/[₹,\s]/g, '').replace('−', '-');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, sign, whole, frac = ''] = match;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return sign === '-' ? -paise : paise;
}

/** Every representation of one ISO date ('YYYY-MM-DD') section 14's table names, normalized (lowercase, ordinal suffixes stripped) for comparison. */
function normalizedDateRepresentations(iso: string): string[] {
  const [y, m, d] = iso.split('-').map(Number);
  const monthName = MONTH_NAMES[m - 1];
  const shortMonth = monthName.slice(0, 3);
  const reps = [
    iso,
    `${d} ${shortMonth}`,
    `${d} ${monthName} ${y}`,
    `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`,
  ];
  return reps.map(normalizeDateToken);
}

function normalizeDateToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(\d+)(st|nd|rd|th)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNumericToken(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s%]/g, '').replace('−', '-');
  if (cleaned === '' || cleaned === '-') return null;
  const value = Number(cleaned);
  return Number.isNaN(value) ? null : value;
}

interface Allowlist {
  numbers: Set<number>;
  dates: Set<string>;
}

/**
 * Walk the evidence bundle recursively. A bare JSON number gets both
 * itself and its ×100 form (covers a ratio like confidence: 0.94 also
 * being written as "94%"). A money-formatted string gets its paise value
 * and that value ÷100 (covers "₹4,820.00" also being written as "4820").
 * An ISO date string gets all of section 14's table representations.
 * **Composition values are walked in along with everything else** —
 * section 14 calls this out explicitly as the guard's most important job.
 */
function buildAllowlist(bundle: unknown): Allowlist {
  const numbers = new Set<number>(CARVE_OUT_NUMBERS);
  const dates = new Set<string>();

  function walk(value: unknown): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') {
      numbers.add(value);
      numbers.add(value * 100);
      return;
    }
    if (typeof value === 'string') {
      if (isIsoDateString(value)) {
        for (const rep of normalizedDateRepresentations(value)) dates.add(rep);
        return;
      }
      if (isMoneyLikeString(value)) {
        const paise = parseMoneyLikeToPaise(value);
        if (paise !== null) {
          numbers.add(paise);
          numbers.add(paise / 100);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        walk((value as Record<string, unknown>)[key]);
      }
    }
  }

  walk(bundle);
  return { numbers, dates };
}

export interface NumberGuardResult {
  pass: boolean;
  /** The exact substrings from the explanation that failed to match the allowlist. Empty when pass is true. */
  rejectedTokens: string[];
}

/**
 * Check an LLM-written explanation against the evidence bundle it was
 * given. Any numeric or date token in the text that doesn't resolve to
 * something in the bundle (after normalization, plus the documented
 * carve-outs) fails the whole explanation — there is no partial credit;
 * `explainException` (lib/ai/explainer.ts) discards the text entirely on
 * any rejection.
 */
export function checkNumberGuard(explanation: string, evidenceBundle: unknown): NumberGuardResult {
  const allowlist = buildAllowlist(evidenceBundle);
  const rejectedTokens: string[] = [];

  // Date-shaped tokens first, and masked out of the text afterward, so
  // their digits aren't also picked up as separate plain numbers below.
  let remaining = explanation;
  const dateMatches = explanation.match(DATE_TOKEN_REGEX) ?? [];
  for (const raw of dateMatches) {
    if (!allowlist.dates.has(normalizeDateToken(raw))) rejectedTokens.push(raw);
    remaining = remaining.replaceAll(raw, ' ');
  }

  const numericMatches = remaining.match(NUMERIC_TOKEN_REGEX) ?? [];
  for (const raw of numericMatches) {
    const value = normalizeNumericToken(raw);
    if (value === null) continue;
    if (!allowlist.numbers.has(value)) rejectedTokens.push(raw);
  }

  return { pass: rejectedTokens.length === 0, rejectedTokens };
}
