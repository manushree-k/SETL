#!/usr/bin/env node
// Synthetic data generator for Setl. SETL_BLUEPRINT.md sections 7 and 8.
//
//     npm run generate -- --seed 20260827 --profile kiranakart --out data/main
//
// Generates FORWARD through the real causal chain — profile, then orders,
// then payments, then fees, then refunds, disputes, adjustments, then
// settlement batching, then bank credits — and only then mutates the clean
// output to inject anomalies. Ground truth (prompt 05) is derived from
// what actually happened during generation, never reconstructed by
// re-analysing the CSVs afterward.
//
// Every random draw goes through one Rng instance seeded from --seed, so
// running this twice with the same seed must produce byte-identical CSVs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../lib/rng';
import { KIRANAKART_RATE_CARD, BOMBAYWEAVE_RATE_CARD } from '../lib/rateCard';
import type {
  BankLine,
  CardType,
  GroundTruthFile,
  GroundTruthRecord,
  MerchantProfile,
  Order,
  PaymentMethod,
  RecordSource,
  Settlement,
  SettlementLine,
} from '../lib/types';
import { formatPaise, roundHalfUp, toPaise, type Paise } from '../lib/money';
import { parseIST, formatISTDate, settlementCycleDate, daysBetweenIST } from '../lib/dates';
import { computeFee } from '../lib/rateCard';

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

interface CliArgs {
  seed: number;
  profile: string;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Flag --${name} is missing its value.`);
      }
      flags.set(name, value);
      i += 1;
    }
  }

  const missing = ['seed', 'profile', 'out'].filter((f) => !flags.has(f));
  if (missing.length > 0) {
    throw new Error(
      `Missing required flag(s): ${missing.map((f) => `--${f}`).join(', ')}. ` +
        `Usage: generate.ts --seed <int> --profile <name> --out <dir>`
    );
  }

  const seedRaw = flags.get('seed')!;
  const seed = Number(seedRaw);
  if (!Number.isInteger(seed)) {
    throw new Error(`--seed must be an integer, received ${JSON.stringify(seedRaw)}.`);
  }

  return { seed, profile: flags.get('profile')!, out: flags.get('out')! };
}

// ---------------------------------------------------------------------------
// Merchant profiles
//
// A profile is everything that differs between merchants: their rate
// card, method mix, refund behaviour, order-value distribution and bank
// narration style. The seed is NOT part of a profile — it is a run
// parameter, supplied by --seed, independent of which merchant is chosen.
// ---------------------------------------------------------------------------

/**
 * 14 HDFC-style narration templates for the main profile. `{utr}` and
 * `{ref}` are substituted per bank line when narrations are generated
 * (a later section). Deliberately varied in case, separator style and UTR
 * placement — at least 3 of these are written so a naive regex (one that
 * assumes the UTR is a cleanly delimited token) will fail to extract the
 * UTR cleanly, which is what gives the LLM narration parser a real job.
 * Marked HARD below for the three-plus that are meant to defeat a naive regex.
 */
const KIRANAKART_NARRATION_TEMPLATES: string[] = [
  'NEFT-RAZORPAY SOFTWARE PVT LTD-{utr}-HDFC',
  'IMPS/P2A/{ref}/RAZORPAY/SETTLEMENT',
  'RTGS CR RAZORPAYSOFT UTR{utr}', // HARD: UTR glued to "UTR" with no separator
  'NEFT CR-HDFC0000060-RAZORPAY SOFTWA-{UTR_UPPER}-',
  'UPI/SETTLEMENT/{utr}/RAZORPAY',
  'MMT/IMPS/{ref}/Razorpay Settle/HDFC',
  'NEFT INWARD {utr} RAZORPAY SOFTWARE PRIVATE LIMI',
  'BY TRANSFER-NEFT*HDFC0000060*{utr}*RAZORPAY',
  'NEFT/{ref}/RAZORPAYSOFT/HDFC0000060/{utr}', // HARD: two ID-shaped tokens present
  'RAZORPAY SETTLEMENT {utr}HDFC0000060', // HARD: UTR runs directly into the next token
  'INB/RAZORPAY SOFTWARE/NEFT/{utr}',
  'TPT-{utr}-RAZORPAY-HDFC BANK LTD',
  'ACH CR RAZORPAY SOFTWARE PVT LTD {utr}',
  'NEFT-{ref}-RAZORPAYSOFTWAREPVTLTD-{UTR_UPPER}',
];

const KIRANAKART_PROFILE: MerchantProfile = {
  name: 'kiranakart',
  rateCard: KIRANAKART_RATE_CARD,
  methodMix: { upi: 0.55, card: 0.3, netbanking: 0.1, wallet: 0.05 },
  // Not stated explicitly in the blueprint for the main profile — the
  // blueprint only pins the held-out profile's card mix at "8%
  // international." A low share here is what makes that contrast
  // meaningful; picked as a small, clearly-flagged default rather than 0.
  internationalCardShare: 0.03,
  amountBands: [
    { min: toPaise(30000), max: toPaise(250000), weight: 70 }, // ₹300–₹2,500
    { min: toPaise(250000), max: toPaise(1000000), weight: 25 }, // ₹2,500–₹10,000
    { min: toPaise(1000000), max: toPaise(6000000), weight: 5 }, // ₹10,000–₹60,000
  ],
  // Not stated explicitly for main either; loosely anchored to injected
  // case 3 ("refund netted", ~24 of 300 records, ~8%) as a plausible order
  // of magnitude for a snacks D2C merchant.
  refundRate: 0.08,
  ordersPerDay: 14,
  days: 21, // section 8: "21 days of orders"
  // Not pinned by the blueprint — an arbitrary but plausible Monday
  // inside the 2026 build window. Only the day-of-week alignment (for
  // weekend/holiday spread) and the 21-day span matter, not this exact date.
  startDate: '2026-03-02',
  narrationTemplates: KIRANAKART_NARRATION_TEMPLATES,
  bankRefNoBlankRate: 0.3,
};

/**
 * 14 ICICI/Axis-style narration templates for the held-out profile —
 * deliberately a different bank house style, different separators, from
 * the main profile's HDFC style. Several carry no {utr} at all (ICICI/Axis
 * narrations lean more on a bare reference number than HDFC's UTR-heavy
 * style in this dataset), consistent with section 9's "ref_no blank far
 * more often" — the settlement's own identity then rests on {ref} alone.
 */
const BOMBAYWEAVE_NARRATION_TEMPLATES: string[] = [
  'NEFT-ICIC0001234-RAZORPAY SOFTWARE PVT LTD-{utr}',
  'IMPS-{ref}-RAZORPAY SOFTWARE-AXIS BANK', // no UTR
  'UPI/{utr}/RAZORPAYSOFTWARE@AXISBANK',
  'RTGS/{utr}/RAZORPAY SOFTWARE PVT LTD/ICICI',
  'NEFT/ICIC0001234/RAZORPAY SOFTWARE/{utr}',
  'BY TRANSFER-IMPS/{ref}/RAZORPAY/AXIS', // no UTR
  'INB/{utr}/RAZORPAY SOFTWARE PVT LTD',
  'ICIC-NEFT-RAZORPAYSOFTWAREPVTLTD-{UTR_UPPER}',
  'AXISB/NEFT/{ref}/RAZORPAY SETTLEMENT', // no UTR
  'UPI/P2M/{utr}/RAZORPAY',
  'NEFT CR/RAZORPAY SOFTWARE/{utr}/ICICI BANK',
  'IMPS/{ref}/RAZORPAY SOFT/AXISBANK LTD', // no UTR
  'TRANSFER FROM RAZORPAY SOFTWARE-{utr}',
  'RTGS-{UTR_UPPER}-RAZORPAY-ICICI0001234',
];

/**
 * Held-out profile ("bombayweave"), section 9. Differs from kiranakart on
 * all six stated axes: seed (supplied by the CLI, not here), merchant
 * category and order-value range, method mix with 8% international,
 * bank narration style, rate card (incl. the flat netbanking tier), and
 * anomaly mix (see PROFILE_TUNING above).
 */
const BOMBAYWEAVE_PROFILE: MerchantProfile = {
  name: 'bombayweave',
  rateCard: BOMBAYWEAVE_RATE_CARD,
  // Section 9: "Card 60% (more credit cards), UPI 25%, netbanking 15%,
  // 8% international" — no wallet share stated for this profile.
  methodMix: { upi: 0.25, card: 0.6, netbanking: 0.15, wallet: 0 },
  internationalCardShare: 0.08,
  // Apparel, "₹1,200–₹1,80,000, lower volume higher value" — same 70/25/5
  // mixture shape as main, re-ranged to the stated span.
  amountBands: [
    { min: toPaise(120000), max: toPaise(800000), weight: 70 }, // ₹1,200–₹8,000
    { min: toPaise(800000), max: toPaise(4000000), weight: 25 }, // ₹8,000–₹40,000
    { min: toPaise(4000000), max: toPaise(18000000), weight: 5 }, // ₹40,000–₹1,80,000
  ],
  // "Much higher refund rate (apparel returns)" — apparel return rates
  // commonly run 20-40% in practice; kiranakart's is 0.08.
  refundRate: 0.22,
  ordersPerDay: 9, // "lower volume" than kiranakart's 14/day
  days: 21,
  // Not pinned by the blueprint; a different month from kiranakart's
  // March 2026 window so the two batches have distinct calendar footprints.
  startDate: '2026-04-06',
  narrationTemplates: BOMBAYWEAVE_NARRATION_TEMPLATES,
  bankRefNoBlankRate: 0.6, // "ref_no blank far more often" than main's 0.3
};

/** Human-readable order reference prefix per merchant, e.g. KK-2026-04412. */
const ORDER_REF_PREFIX: Record<string, string> = { kiranakart: 'KK', bombayweave: 'BW' };

const PROFILES: Record<string, MerchantProfile> = {
  kiranakart: KIRANAKART_PROFILE,
  bombayweave: BOMBAYWEAVE_PROFILE,
};

function getProfile(name: string): MerchantProfile {
  const profile = PROFILES[name];
  if (!profile) {
    const known = Object.keys(PROFILES).join(', ');
    throw new Error(`Unknown profile ${JSON.stringify(name)}. Known profiles: ${known}.`);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Generation steps — causal order from section 8. Each is filled in one
// at a time; for now every step after orders is a stub returning an empty
// result so the orchestration shape can be verified before any single
// step's logic is written.
// ---------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdef';

/** Random lowercase hex string of the given length, via the seeded Rng. */
function randomHex(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += HEX_DIGITS[rng.int(0, HEX_DIGITS.length - 1)];
  }
  return out;
}

/**
 * Nudge a raw paise amount to a realistic retail price point — ending in
 * 9, in 0, or in 99 — by replacing its low-order digits. Uses only `%`,
 * `+` and `-` on the paise value, never `/` or `*`: money.ts is the only
 * place a fractional intermediate is allowed to exist, and none of these
 * three operators can produce one, so this stays exact by construction
 * without needing money.ts itself.
 *
 * Falls back to the unrounded amount if nudging would push it outside the
 * sampled band — a handful of raw values near a band edge, left alone.
 */
function roundToPricePoint(rawPaise: number, band: { min: Paise; max: Paise }, rng: Rng): number {
  const pattern = rng.pick(['endsIn9', 'endsIn0', 'endsIn99'] as const);

  let nudged: number;
  if (pattern === 'endsIn9') {
    const remainder = rawPaise % 1000; // last 1 rupee digit, in paise
    nudged = rawPaise - remainder + 900; // ...X9.00
  } else if (pattern === 'endsIn0') {
    const remainder = rawPaise % 1000;
    nudged = rawPaise - remainder; // ...X0.00
  } else {
    const remainder = rawPaise % 10000; // last 2 rupee digits, in paise
    nudged = rawPaise - remainder + 9900; // ...X99.00
  }

  if (nudged < band.min || nudged > band.max) return rawPaise;
  return nudged;
}

/** Sample one order amount from the profile's amount-band mixture. */
function sampleAmount(profile: MerchantProfile, rng: Rng): Paise {
  const band = rng.weightedPick(profile.amountBands.map((b) => ({ value: b, weight: b.weight })));
  const raw = rng.int(band.min, band.max);
  return toPaise(roundToPricePoint(raw, band, rng));
}

function generateOrders(profile: MerchantProfile, rng: Rng): Order[] {
  const orders: Order[] = [];
  const start = parseIST(profile.startDate);
  const prefix = ORDER_REF_PREFIX[profile.name] ?? 'ORD';
  let refCounter = 1;

  for (let day = 0; day < profile.days; day += 1) {
    // Real order volume varies day to day; vary the count around the
    // target average rather than issuing exactly ordersPerDay every day.
    const dayCount = Math.max(1, profile.ordersPerDay + rng.int(-3, 3));

    for (let i = 0; i < dayCount; i += 1) {
      const hour = rng.int(6, 23); // D2C orders skew toward evenings, but spread widely
      const minute = rng.int(0, 59);
      const second = rng.int(0, 59);
      const createdAt = new Date(
        start.getTime() + day * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000
      );

      const year = formatISTDate(createdAt).slice(0, 4);
      const orderRef = `${prefix}-${year}-${String(refCounter).padStart(5, '0')}`;
      refCounter += 1;

      orders.push({
        order_id: `ord_${randomHex(rng, 12)}`,
        order_ref: orderRef,
        customer_ref: `cust_${randomHex(rng, 4)}`,
        order_amount_paise: sampleAmount(profile, rng),
        currency: 'INR',
        created_at: createdAt,
        // Finalized by the refunds step later — every order starts paid.
        order_status: 'paid',
        refund_issued_paise: toPaise(0),
      });
    }
  }

  return orders;
}

/**
 * Per-profile tuning knobs that are NOT part of the shared MerchantProfile
 * type (lib/types.ts is out of scope for the prompt that introduced the
 * second profile) — the card credit/debit split, and how many of each of
 * the 10 mutation-built injected cases to produce. Section 9 asks for the
 * held-out profile's anomaly mix to be "skewed: more aggregation and
 * split cases, more corrupted narration, fewer clean exact matches" —
 * that skew lives entirely in the counts below, nowhere else.
 *
 * kiranakart's counts here are exactly the ones tuned and verified in
 * prompt 04. Do not change them without re-verifying that batch.
 */
interface ProfileTuning {
  cardCreditShare: number;
  timingDifference: number;
  partialSettlement: number;
  splitPayout: number;
  aggregatedCreditPairs: number;
  duplicateCredit: number;
  missingInBank: number;
  roundingResidual: number;
  feeOvercharge: number;
  ambiguousMatchPairs: number;
  corruptedNarration: number;
}

const PROFILE_TUNING: Record<string, ProfileTuning> = {
  kiranakart: {
    cardCreditShare: 0.55, // roughly even — not stated explicitly for main; see bombayweave's contrast below
    timingDifference: 6,
    partialSettlement: 2,
    splitPayout: 2,
    aggregatedCreditPairs: 2,
    duplicateCredit: 1,
    missingInBank: 1,
    roundingResidual: 2,
    feeOvercharge: 2,
    ambiguousMatchPairs: 1,
    corruptedNarration: 3,
  },
  bombayweave: {
    cardCreditShare: 0.75, // section 9: "more credit cards"
    timingDifference: 4,
    partialSettlement: 2,
    splitPayout: 2, // parity with main — budget below prioritises aggregation instead
    aggregatedCreditPairs: 3, // skewed up from main's 2 pairs — the main "more aggregation" signal
    duplicateCredit: 1,
    missingInBank: 1, // MUST fire — one of the 3 genuinely-unresolvable cases; see budget note below
    roundingResidual: 1, // fewer of the "clean, auto-resolved" cases
    feeOvercharge: 2,
    ambiguousMatchPairs: 1,
    corruptedNarration: 3, // same as main — settlement budget below has no room to push this higher
  },
  // Settlement budget for bombayweave (only 15 settlements total, shared
  // across every settlement-claiming case): splitPayout(2) +
  // aggregatedCreditPairs(3 pairs = 6) + duplicateCredit(1) +
  // missingInBank(1) + roundingResidual(1) + corruptedNarration(3) = 14,
  // leaving 1 settlement of headroom. An earlier attempt pushed
  // corruptedNarration to 4 and splitPayout to 3 (17 settlements needed,
  // more than exist), which silently starved missingInBank to zero —
  // caught by checking every injected case actually fired, not assumed.
};

function tuningFor(profile: MerchantProfile): ProfileTuning {
  const tuning = PROFILE_TUNING[profile.name];
  if (!tuning) throw new Error(`No ProfileTuning entry for profile ${JSON.stringify(profile.name)}.`);
  return tuning;
}

function samplePaymentMethod(profile: MerchantProfile, rng: Rng): PaymentMethod {
  const mix = profile.methodMix;
  return rng.weightedPick([
    { value: 'upi' as const, weight: mix.upi },
    { value: 'card' as const, weight: mix.card },
    { value: 'netbanking' as const, weight: mix.netbanking },
    { value: 'wallet' as const, weight: mix.wallet },
  ]);
}

function generatePaymentsAndFees(
  profile: MerchantProfile,
  rng: Rng,
  orders: Order[]
): SettlementLine[] {
  const lines: SettlementLine[] = [];

  // The clean chain is 1:1: every order gets exactly one payment line at
  // this stage. Cancelled orders, missing links and ambiguous cases are
  // deliberately NOT introduced here — they are mutations the anomaly
  // injection step applies afterward, so ground truth can record exactly
  // what each mutation did rather than this step guessing at anomalies.
  for (const order of orders) {
    const method = samplePaymentMethod(profile, rng);

    let cardType: CardType | null = null;
    let international = false;
    if (method === 'card') {
      cardType = rng.bool(tuningFor(profile).cardCreditShare) ? 'credit' : 'debit';
      international = rng.bool(profile.internationalCardShare);
    }

    const amountPaise = order.order_amount_paise;
    const { feePaise, gstPaise } = computeFee(
      profile.rateCard,
      method,
      cardType,
      international,
      amountPaise
    );

    // Capture happens shortly after the order is placed — a small
    // deterministic delay, not the same instant, but never later than
    // the same day.
    const capturedAt = new Date(order.created_at.getTime() + rng.int(2, 120) * 1000);

    lines.push({
      entity_id: `pay_${randomHex(rng, 14)}`,
      type: 'payment',
      debit_paise: toPaise(0),
      // Pass 4's internal-balance identity: credit == amount - fee - tax.
      // Plain integer subtraction — exact, no fractional intermediate.
      credit_paise: toPaise(amountPaise - feePaise - gstPaise),
      amount_paise: amountPaise,
      fee_paise: feePaise,
      tax_paise: gstPaise,
      on_hold: false,
      settled: false, // set true once batched into a settlement
      created_at: capturedAt,
      settled_at: null,
      settlement_id: null, // filled in by settlement batching
      settlement_utr: null,
      order_id: order.order_id,
      method,
      card_network: method === 'card' ? rng.pick(['VISA', 'MASTERCARD', 'RUPAY', 'AMEX']) : null,
      card_type: cardType,
      international,
      dispute_id: null,
      description: '',
    });
  }

  return lines;
}

/**
 * Full vs. partial refund split. Not stated in the blueprint; a majority
 * of full refunds is a plausible shape for a snacks D2C merchant (a
 * partial refund usually implies a multi-item order with one item
 * returned, which is less common at this basket size).
 */
const KIRANAKART_FULL_REFUND_SHARE = 0.7;

function generateRefunds(
  profile: MerchantProfile,
  rng: Rng,
  orders: Order[],
  lines: SettlementLine[]
): void {
  // Look up each order's payment line so the refund can inherit its
  // method/card details — a refund goes back the way it came.
  const paymentByOrderId = new Map<string, SettlementLine>();
  for (const line of lines) {
    if (line.type === 'payment' && line.order_id) {
      paymentByOrderId.set(line.order_id, line);
    }
  }

  for (const order of orders) {
    if (!rng.bool(profile.refundRate)) continue;

    const payment = paymentByOrderId.get(order.order_id);
    if (!payment) {
      // Every order has exactly one payment line at this stage — the
      // clean 1:1 chain built by the previous step — so this should be
      // unreachable. Fail loudly rather than silently skip a refund.
      throw new Error(`generateRefunds: no payment line found for order ${order.order_id}`);
    }

    const isFullRefund = rng.bool(KIRANAKART_FULL_REFUND_SHARE);
    let refundAmount: Paise;
    if (isFullRefund) {
      refundAmount = order.order_amount_paise;
    } else {
      const bps = rng.int(2000, 8000); // a partial refund of 20%-80% of the order
      // Same sanctioned pattern as computeFee(): integer * integer numerator,
      // fed through roundHalfUp for the exact division. Never a bare `/`.
      refundAmount = toPaise(roundHalfUp(order.order_amount_paise * bps, 10000));
    }

    // Dated after the order, per section 8. A day-or-more delay plus a
    // random time of day, rather than a fixed offset.
    const delayDays = rng.int(1, 10);
    const delayMs = rng.int(0, 86_399) * 1000;
    const refundedAt = new Date(order.created_at.getTime() + delayDays * 86_400_000 + delayMs);

    lines.push({
      entity_id: `rfnd_${randomHex(rng, 14)}`,
      type: 'refund',
      debit_paise: refundAmount, // money OUT of the merchant's balance
      credit_paise: toPaise(0),
      amount_paise: refundAmount,
      fee_paise: toPaise(0), // no MDR review on a refund in this model
      tax_paise: toPaise(0),
      on_hold: false,
      settled: false, // set by settlement batching
      created_at: refundedAt,
      settled_at: null,
      settlement_id: null,
      settlement_utr: null,
      order_id: order.order_id,
      method: payment.method,
      card_network: payment.card_network,
      card_type: payment.card_type,
      international: payment.international,
      dispute_id: null,
      description: '',
    });

    order.order_status = isFullRefund ? 'refunded' : 'partially_refunded';
    order.refund_issued_paise = refundAmount;
  }
}

/**
 * Fraction of still-'paid' payment lines put on dispute hold. Targets
 * roughly 9 of ~300 records, matching injected case 9's count in section 8.
 */
const KIRANAKART_DISPUTE_RATE = 0.03;

function generateDisputes(
  _profile: MerchantProfile,
  rng: Rng,
  orders: Order[],
  lines: SettlementLine[]
): void {
  // Only a payment whose order was never touched by the refund step is
  // eligible: a record that is both refunded and disputed would be
  // ambiguous in this model, so the two mutations are kept exclusive.
  const paidOrderIds = new Set(
    orders.filter((o) => o.order_status === 'paid').map((o) => o.order_id)
  );

  for (const line of lines) {
    if (line.type !== 'payment') continue;
    if (!line.order_id || !paidOrderIds.has(line.order_id)) continue;
    if (!rng.bool(KIRANAKART_DISPUTE_RATE)) continue;

    // A dispute hold freezes the payment: captured, but deliberately kept
    // out of any settlement until the dispute resolves. The settlement
    // batching step (next) must skip on_hold lines for this to hold.
    line.on_hold = true;
    line.dispute_id = `dsp_${randomHex(rng, 12)}`;
  }
}

/**
 * Number of deliberately opaque adjustment lines — descriptions a rule
 * cannot classify, which is what gives the LLM narration/explanation
 * layer a real job (injected case 12, ~9 of 300 records in section 8).
 */
const KIRANAKART_OPAQUE_ADJUSTMENT_COUNT = 9;

/**
 * India's Section 194-O: e-commerce operators withhold 1% TDS on gross
 * sales at source. Modelled as one adjustment per calendar week of the
 * order window, sized off that week's actual gross payments — not a
 * guessed constant — so it is a real, checkable 1% rather than a prop.
 * This is also the only source of the TDS_194O exception class: without
 * it, that taxonomy entry would never fire in the dataset.
 */
function generateTdsAdjustments(profile: MerchantProfile, rng: Rng, lines: SettlementLine[]): void {
  const start = parseIST(profile.startDate);
  const weekCount = Math.ceil(profile.days / 7);

  for (let week = 0; week < weekCount; week += 1) {
    const weekStartMs = start.getTime() + week * 7 * 86_400_000;
    const weekEndMs = start.getTime() + Math.min((week + 1) * 7, profile.days) * 86_400_000;

    let weeklyGross = 0;
    for (const line of lines) {
      if (line.type !== 'payment') continue;
      const t = line.created_at.getTime();
      if (t >= weekStartMs && t < weekEndMs) {
        weeklyGross += line.amount_paise; // plain integer addition — exact
      }
    }
    if (weeklyGross === 0) continue; // no sales that week, nothing to withhold

    // 1% = 100 bps. Same sanctioned pattern as computeFee(): integer
    // numerator, exact division via roundHalfUp.
    const tdsPaise = toPaise(roundHalfUp(weeklyGross * 100, 10_000));

    lines.push({
      entity_id: `adj_${randomHex(rng, 14)}`,
      type: 'adjustment',
      debit_paise: tdsPaise,
      credit_paise: toPaise(0),
      amount_paise: tdsPaise,
      fee_paise: toPaise(0),
      tax_paise: toPaise(0),
      on_hold: false,
      settled: false,
      created_at: new Date(weekEndMs - 3_600_000), // an hour before the week closes
      settled_at: null,
      settlement_id: null,
      settlement_utr: null,
      order_id: null,
      method: null,
      card_network: null,
      card_type: null,
      international: false,
      dispute_id: null,
      description: `TDS 194O DEDUCTION - 1% ON GROSS SALES WK${week + 1}`,
    });
  }
}

/** One of the three opaque-description styles from section 8, case 12. */
function randomOpaqueDescription(rng: Rng): string {
  const kind = rng.pick(['misc', 'chargeback', 'svc'] as const);
  if (kind === 'misc') return `MISC DR ADJ REF ${rng.int(10_000, 99_999)}`;
  if (kind === 'chargeback') return `chargeback prov reversal Q${rng.int(1, 4)}`;
  return 'svc adj — see note';
}

function generateAdjustments(profile: MerchantProfile, rng: Rng, lines: SettlementLine[]): void {
  generateTdsAdjustments(profile, rng, lines);

  const start = parseIST(profile.startDate);

  for (let i = 0; i < KIRANAKART_OPAQUE_ADJUSTMENT_COUNT; i += 1) {
    const amount = toPaise(rng.int(50_000, 500_000)); // ₹500–₹5,000
    const isCredit = rng.bool(0.5);
    const dayOffset = rng.int(0, profile.days - 1);
    const secondsIntoDay = rng.int(0, 86_399);
    const createdAt = new Date(start.getTime() + dayOffset * 86_400_000 + secondsIntoDay * 1_000);

    lines.push({
      entity_id: `adj_${randomHex(rng, 14)}`,
      type: 'adjustment',
      debit_paise: isCredit ? toPaise(0) : amount,
      credit_paise: isCredit ? amount : toPaise(0),
      amount_paise: amount,
      fee_paise: toPaise(0),
      tax_paise: toPaise(0),
      on_hold: false,
      settled: false,
      created_at: createdAt,
      settled_at: null,
      settlement_id: null,
      settlement_utr: null,
      order_id: null,
      method: null,
      card_network: null,
      card_type: null,
      international: false,
      dispute_id: null,
      description: randomOpaqueDescription(rng),
    });
  }
}

const UTR_DIGITS = '0123456789';
const UTR_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** A UTR shaped like Razorpay's real ones, e.g. '1568176960vxp0rj': 10 digits then 6 lowercase letters. */
function randomUtr(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += UTR_DIGITS[rng.int(0, UTR_DIGITS.length - 1)];
  for (let i = 0; i < 6; i += 1) out += UTR_LETTERS[rng.int(0, UTR_LETTERS.length - 1)];
  return out;
}

/**
 * Group every settled-eligible line by its settlement cycle date and turn
 * each group into one settlement header.
 *
 * Each line's OWN event date (a payment's capture, a refund's date, an
 * adjustment's date) determines its T+2 cycle independently; lines whose
 * cycle date coincides are paid out together. Real Razorpay instead nets
 * refunds/adjustments into whatever cycle is next open — this is a
 * deliberate simplification that keeps the causal chain simple while
 * still producing multi-line settlements with a mix of record types.
 *
 * amount/fees/tax are summed by plain integer addition over already-exact
 * per-line values, so Pass 4's internal-balance identities hold on this
 * output by construction, not by luck.
 */
function batchIntoSettlements(
  _profile: MerchantProfile,
  rng: Rng,
  lines: SettlementLine[]
): Settlement[] {
  // A line on dispute hold is deliberately excluded: it is frozen out of
  // every settlement until the dispute resolves.
  const eligible = lines.filter((l) => !l.on_hold && l.settlement_id === null);

  const groups = new Map<string, SettlementLine[]>();
  for (const line of eligible) {
    const key = formatISTDate(settlementCycleDate(line.created_at));
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }

  // A cycle date whose lines net negative (a week's TDS or a run of
  // refunds landing on a day with little same-day payment volume to
  // offset them) is not a real payout — Razorpay never pays out a
  // negative amount. Per section 1's own description ("Razorpay ...
  // deducts the refund from your next settlement"), the shortfall is
  // carried forward and merged into the NEXT cycle date until the
  // combined group is non-negative, rather than clamped or hidden.
  const sortedKeys = Array.from(groups.keys()).sort();
  const batches: { anchorKey: string; group: SettlementLine[] }[] = [];
  let carry: SettlementLine[] = [];

  for (const key of sortedKeys) {
    const combined = carry.concat(groups.get(key)!);
    carry = [];
    const net = combined.reduce((sum, l) => sum + l.credit_paise - l.debit_paise, 0);
    if (net < 0) {
      carry = combined; // shortfall rolls into the next cycle date
    } else {
      batches.push({ anchorKey: key, group: combined });
    }
  }
  if (carry.length > 0) {
    if (batches.length > 0) {
      batches[batches.length - 1].group.push(...carry);
    } else {
      // Every cycle date was negative — an extreme edge case. Settle it
      // on the last date anyway rather than lose the records.
      batches.push({ anchorKey: sortedKeys[sortedKeys.length - 1], group: carry });
    }
  }

  const settlements: Settlement[] = [];

  for (const { anchorKey, group } of batches) {
    let amount = 0;
    let fees = 0;
    let tax = 0;
    for (const line of group) {
      amount += line.credit_paise - line.debit_paise;
      fees += line.fee_paise;
      tax += line.tax_paise;
    }

    const settlementId = `setl_${randomHex(rng, 14)}`;
    const utr = randomUtr(rng);
    const createdAt = new Date(parseIST(anchorKey).getTime() + 10 * 3_600_000); // mid-morning

    settlements.push({
      settlement_id: settlementId,
      amount_paise: toPaise(amount),
      fees_paise: toPaise(fees),
      tax_paise: toPaise(tax),
      utr_number: utr,
      status: 'processed',
      created_at: createdAt,
    });

    for (const line of group) {
      line.settlement_id = settlementId;
      line.settlement_utr = utr;
      line.settled = true;
      line.settled_at = createdAt;
    }
  }

  return settlements;
}

const BANK_REF_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A bank-internal reference token — shorter and visually distinct from a UTR. */
function randomBankRef(rng: Rng, length = 10): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += BANK_REF_CHARS[rng.int(0, BANK_REF_CHARS.length - 1)];
  return out;
}

/** Substitute {utr}, {UTR_UPPER} and {ref} into one narration template. */
function fillNarrationTemplate(template: string, utr: string, ref: string): string {
  return template.replace(/\{UTR_UPPER\}/g, utr.toUpperCase()).replace(/\{utr\}/g, utr).replace(/\{ref\}/g, ref);
}

// An arbitrary but plausible pre-existing account balance the statement
// starts from — the generator only models Razorpay settlement credits, so
// this is the entire balance history for the batch's bank statement.
const STARTING_BALANCE_PAISE = toPaise(500_000); // ₹5,000

function generateBankLines(
  profile: MerchantProfile,
  rng: Rng,
  settlements: Settlement[]
): BankLine[] {
  // Chronological order: the statement's line_no and closing_balance are
  // both order-dependent, so settlements must be processed in the order
  // they actually paid out.
  const sorted = settlements.slice().sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  const bankLines: BankLine[] = [];
  let runningBalance = STARTING_BALANCE_PAISE;
  let lineNo = 1;

  for (const settlement of sorted) {
    const template = rng.pick(profile.narrationTemplates);
    const refToken = randomBankRef(rng);
    const narration = fillNarrationTemplate(template, settlement.utr_number, refToken);

    // "Sometimes blank, sometimes useless" — section 7. Independent of
    // whether the narration template happened to use {ref}.
    const refNoBlank = rng.bool(profile.bankRefNoBlankRate);

    runningBalance = toPaise(runningBalance + settlement.amount_paise);

    bankLines.push({
      line_no: lineNo,
      value_date: settlement.created_at,
      narration,
      ref_no: refNoBlank ? null : refToken,
      debit_paise: toPaise(0),
      credit_paise: settlement.amount_paise,
      closing_balance_paise: runningBalance,
    });

    lineNo += 1;
  }

  return bankLines;
}

interface GeneratedRecords {
  orders: Order[];
  lines: SettlementLine[];
  settlements: Settlement[];
  bankLines: BankLine[];
}

interface GeneratedBatch extends GeneratedRecords {
  // Ground truth is recorded at the moment each anomaly is injected, per
  // prompt 05 — never reconstructed afterward by re-analysing the CSVs.
  // This is that log. Writing it to ground_truth.json is prompt 05's job;
  // this script only assembles it.
  groundTruthLog: GroundTruthRecord[];
}

/**
 * record_id for a ground truth entry. Uses the record's own natural
 * identifier where one exists (order_id, entity_id, settlement_id) since
 * that is directly traceable back to the CSVs; a bank line has no natural
 * string id, so it gets 'bank_0001'-style numbering from its line_no,
 * matching the shape in section 7's own ground_truth.json example.
 */
function recordId(source: RecordSource, natural: string | number): string {
  if (source === 'bank') return `bank_${String(natural).padStart(4, '0')}`;
  return String(natural);
}

/**
 * Case 3, refund netted — already produced by generateRefunds(). This
 * function only records what already happened; it makes no mutation.
 */
function logRefundNettedCases(batch: GeneratedRecords, log: GroundTruthRecord[]): void {
  const paymentByOrderId = new Map<string, SettlementLine>();
  for (const line of batch.lines) {
    if (line.type === 'payment' && line.order_id) paymentByOrderId.set(line.order_id, line);
  }

  for (const line of batch.lines) {
    if (line.type !== 'refund' || !line.order_id) continue;
    const order = batch.orders.find((o) => o.order_id === line.order_id);
    if (!order) continue;

    log.push({
      record_id: recordId('settlement_line', line.entity_id),
      source: 'settlement_line',
      injected_case: 'refund_netted',
      expected_link_ids: [order.order_id],
      expected_class: 'REFUND_NETTED',
      expected_decision: 'AUTO_RESOLVED',
      is_resolvable: true,
      expected_reason: `Refund of ${formatPaise(line.debit_paise)} against order ${order.order_ref}, netted from the settlement payout.`,
    });
  }
}

/** Case 9, dispute hold — already produced by generateDisputes(). */
function logDisputeHoldCases(batch: GeneratedRecords, log: GroundTruthRecord[]): void {
  for (const line of batch.lines) {
    if (!line.on_hold || !line.dispute_id) continue;

    log.push({
      record_id: recordId('settlement_line', line.entity_id),
      source: 'settlement_line',
      injected_case: 'dispute_hold',
      expected_link_ids: line.order_id ? [line.order_id] : [],
      expected_class: 'DISPUTE_HOLD',
      expected_decision: 'NEEDS_REVIEW',
      is_resolvable: true,
      expected_reason: `Payment ${line.entity_id} is on hold under dispute ${line.dispute_id}; captured but deliberately excluded from any settlement.`,
    });
  }
}

/**
 * TDS_194O — not one of the 14 numbered injected cases, but a real
 * exception class the generator already produces (the weekly TDS
 * adjustments from generateAdjustments). Without a ground-truth entry
 * for these, this taxonomy class would never fire, which section 26's
 * audit calls out as a defect: a documented class that never occurs is a
 * claim the project cannot support.
 */
function logTdsCases(batch: GeneratedRecords, log: GroundTruthRecord[]): void {
  for (const line of batch.lines) {
    if (line.type !== 'adjustment' || !line.description.startsWith('TDS')) continue;

    log.push({
      record_id: recordId('settlement_line', line.entity_id),
      source: 'settlement_line',
      injected_case: 'none', // organic to the clean chain, not one of the 14 mutations
      expected_link_ids: [],
      expected_class: 'TDS_194O',
      expected_decision: 'NEEDS_REVIEW',
      is_resolvable: true,
      expected_reason: `${formatPaise(line.debit_paise)} withheld as Section 194-O TDS on gross sales; verify against Form 26AS.`,
    });
  }
}

/**
 * Case 12, opaque adjustment — already produced by generateAdjustments().
 * The description doesn't match a known structured pattern (it isn't
 * TDS), so a rule-based classifier can only bucket it as AMOUNT_MISMATCH
 * and escalate; per CLAUDE.md, the LLM may narrate this evidence but
 * never decides the class itself.
 */
function logOpaqueAdjustmentCases(batch: GeneratedRecords, log: GroundTruthRecord[]): void {
  for (const line of batch.lines) {
    if (line.type !== 'adjustment' || line.description.startsWith('TDS')) continue;

    log.push({
      record_id: recordId('settlement_line', line.entity_id),
      source: 'settlement_line',
      injected_case: 'opaque_adjustment',
      expected_link_ids: [],
      expected_class: 'AMOUNT_MISMATCH',
      expected_decision: 'NEEDS_REVIEW',
      is_resolvable: true,
      expected_reason: `Adjustment ${line.entity_id} ("${line.description}") does not match a known pattern; needs manual review.`,
    });
  }
}

/**
 * Case 1, exact match — everything the functions above (and, later, the
 * new mutations) did not already claim. Covers all three populations
 * section 16 sums into N, since every order, settlement line and bank
 * line needs a ground-truth answer, not only the interesting exceptions.
 */
function logExactMatchCases(batch: GeneratedRecords, log: GroundTruthRecord[]): void {
  const logged = new Set(log.map((r) => r.record_id));

  for (const order of batch.orders) {
    const id = recordId('order', order.order_id);
    if (logged.has(id)) continue;
    log.push({
      record_id: id,
      source: 'order',
      injected_case: 'none',
      expected_link_ids: [],
      expected_class: 'MATCHED_EXACT',
      expected_decision: 'AUTO_RESOLVED',
      is_resolvable: true,
      expected_reason: `Order ${order.order_ref} links cleanly to its payment; no anomaly.`,
    });
  }

  for (const line of batch.lines) {
    if (line.type !== 'payment') continue;
    const id = recordId('settlement_line', line.entity_id);
    if (logged.has(id)) continue;
    log.push({
      record_id: id,
      source: 'settlement_line',
      injected_case: 'none',
      expected_link_ids: line.order_id ? [line.order_id] : [],
      expected_class: 'MATCHED_EXACT',
      expected_decision: 'AUTO_RESOLVED',
      is_resolvable: true,
      expected_reason: `Payment ${line.entity_id} settled with fees and GST exactly as the rate card predicts.`,
    });
  }

  for (const bankLine of batch.bankLines) {
    const id = recordId('bank', bankLine.line_no);
    if (logged.has(id)) continue;
    const settlement = batch.settlements.find((s) =>
      bankLine.narration.toLowerCase().includes(s.utr_number.toLowerCase())
    );
    log.push({
      record_id: id,
      source: 'bank',
      injected_case: 'none',
      expected_link_ids: settlement ? [settlement.settlement_id] : [],
      expected_class: 'MATCHED_EXACT',
      expected_decision: 'AUTO_RESOLVED',
      is_resolvable: true,
      expected_reason: settlement
        ? `Bank credit ties to settlement ${settlement.settlement_id} by UTR, amount exact.`
        : `Bank credit has no UTR in its narration; resolved by amount and date instead.`,
    });
  }
}

// --- Shared bookkeeping for mutations that move lines between settlements ---

/** Add a line's contribution into a settlement's totals and stamp the link. */
function addLineToSettlement(line: SettlementLine, settlement: Settlement): void {
  settlement.amount_paise = toPaise(settlement.amount_paise + line.credit_paise - line.debit_paise);
  settlement.fees_paise = toPaise(settlement.fees_paise + line.fee_paise);
  settlement.tax_paise = toPaise(settlement.tax_paise + line.tax_paise);
  line.settlement_id = settlement.settlement_id;
  line.settlement_utr = settlement.utr_number;
  line.settled = true;
  line.settled_at = settlement.created_at;
}

/** Reverse of addLineToSettlement — subtracts, does not touch the line's own fields. */
function removeLineFromSettlement(line: SettlementLine, settlement: Settlement): void {
  settlement.amount_paise = toPaise(settlement.amount_paise - line.credit_paise + line.debit_paise);
  settlement.fees_paise = toPaise(settlement.fees_paise - line.fee_paise);
  settlement.tax_paise = toPaise(settlement.tax_paise - line.tax_paise);
}

/**
 * Locate a settlement's (still 1:1, pre-mutation) bank line: by
 * UTR-in-narration first. UTR is the stable key — settlement.amount_paise
 * is NOT, because injectTimingDifference/injectPartialSettlement (which
 * run earlier) legitimately move lines in and out of a settlement,
 * changing its amount after the bank line's fixed credit was generated.
 * Amount-only match is a fallback only for the UTR-less templates, and
 * will correctly fail to find a settlement whose amount has since drifted
 * — that settlement is simply not usable as a candidate here.
 */
function findBankLineForSettlement(bankLines: BankLine[], settlement: Settlement): BankLine | undefined {
  return (
    bankLines.find((b) => b.narration.toLowerCase().includes(settlement.utr_number.toLowerCase())) ??
    bankLines.find((b) => b.credit_paise === settlement.amount_paise)
  );
}

/**
 * Re-sort the bank statement by date and reassign line_no/closing_balance
 * from scratch. Must run AFTER every mutation that adds or removes bank
 * lines (split/aggregate/duplicate, and missing_in_bank later) — those
 * mutations defer their ground-truth logging until after this runs, so
 * record_id (which is keyed off line_no for bank records) stays stable.
 */
function finalizeBankStatement(bankLines: BankLine[]): void {
  bankLines.sort((a, b) => a.value_date.getTime() - b.value_date.getTime() || a.line_no - b.line_no);

  let balance: Paise = STARTING_BALANCE_PAISE;
  let lineNo = 1;
  for (const line of bankLines) {
    balance = toPaise(balance + line.credit_paise - line.debit_paise);
    line.line_no = lineNo;
    line.closing_balance_paise = balance;
    lineNo += 1;
  }
}

type PendingBankEntry = { bankLine: BankLine; entry: Omit<GroundTruthRecord, 'record_id'> };

/**
 * Case 2, timing difference: move a payment into a settlement dated well
 * after its own capture would predict. order_id linkage stays intact —
 * Pass 5 still finds it via tier 1 — so the gap between the order's
 * placement and the settlement's actual date is the signal a classifier
 * reads as TIMING_DIFFERENCE, not a lookup criterion.
 */
function injectTimingDifference(
  rng: Rng,
  batch: GeneratedRecords,
  claimedLineIds: Set<string>,
  log: GroundTruthRecord[],
  count: number
): void {
  const settlementsByDate = batch.settlements
    .slice()
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const settlementById = new Map(batch.settlements.map((s) => [s.settlement_id, s]));

  const candidates = rng.shuffle(
    batch.lines.filter((l) => l.type === 'payment' && l.settlement_id && !claimedLineIds.has(l.entity_id))
  );

  let picked = 0;
  for (const line of candidates) {
    if (picked >= count) break;

    const from = settlementById.get(line.settlement_id!);
    if (!from) continue;

    // At least 3 days later (section 8), falling back to the latest
    // available settlement if the window doesn't reach that far.
    const target =
      settlementsByDate.find((s) => s.created_at.getTime() >= from.created_at.getTime() + 3 * 86_400_000) ??
      settlementsByDate[settlementsByDate.length - 1];
    if (!target || target.settlement_id === from.settlement_id) continue;

    removeLineFromSettlement(line, from);
    addLineToSettlement(line, target);
    claimedLineIds.add(line.entity_id);
    picked += 1;

    const order = batch.orders.find((o) => o.order_id === line.order_id);
    log.push({
      record_id: recordId('settlement_line', line.entity_id),
      source: 'settlement_line',
      injected_case: 'timing_difference',
      expected_link_ids: order ? [order.order_id] : [],
      expected_class: 'TIMING_DIFFERENCE',
      expected_decision: 'AUTO_RESOLVED',
      is_resolvable: true,
      expected_reason: `Captured near a settlement cutoff; settled in ${target.settlement_id} instead of the cycle its own capture date would predict.`,
    });
  }
}

/**
 * Case 4, partial settlement: split one payment's credit across two
 * settlements, each carrying a proportional fee/GST recomputed for its
 * own share — not divided proportionally from the original, so each
 * part's own credit == amount − fee − tax identity holds independently.
 */
function injectPartialSettlement(
  profile: MerchantProfile,
  rng: Rng,
  batch: GeneratedRecords,
  claimedLineIds: Set<string>,
  log: GroundTruthRecord[],
  count: number
): void {
  const settlementById = new Map(batch.settlements.map((s) => [s.settlement_id, s]));
  const candidates = rng.shuffle(
    batch.lines.filter((l) => l.type === 'payment' && l.settlement_id && !claimedLineIds.has(l.entity_id))
  );

  let picked = 0;
  for (const line of candidates) {
    if (picked >= count) break;
    if (!line.method) continue; // defensive — every generated payment line has one

    const settlementA = settlementById.get(line.settlement_id!);
    const others = batch.settlements.filter((s) => s.settlement_id !== line.settlement_id);
    if (!settlementA || others.length === 0) continue;
    const settlementB = rng.pick(others);

    removeLineFromSettlement(line, settlementA);

    const totalAmount = line.amount_paise;
    const splitBps = rng.int(3000, 7000);
    const part1Amount = toPaise(roundHalfUp(totalAmount * splitBps, 10_000));
    const part2Amount = toPaise(totalAmount - part1Amount); // exact remainder

    const fee1 = computeFee(profile.rateCard, line.method, line.card_type, line.international, part1Amount);
    const fee2 = computeFee(profile.rateCard, line.method, line.card_type, line.international, part2Amount);

    // Mutate the original line into "part 1", re-add to its own settlement.
    line.amount_paise = part1Amount;
    line.fee_paise = fee1.feePaise;
    line.tax_paise = fee1.gstPaise;
    line.credit_paise = toPaise(part1Amount - fee1.feePaise - fee1.gstPaise);
    addLineToSettlement(line, settlementA);

    const part2: SettlementLine = {
      entity_id: `pay_${randomHex(rng, 14)}`,
      type: 'payment',
      debit_paise: toPaise(0),
      credit_paise: toPaise(part2Amount - fee2.feePaise - fee2.gstPaise),
      amount_paise: part2Amount,
      fee_paise: fee2.feePaise,
      tax_paise: fee2.gstPaise,
      on_hold: false,
      settled: false,
      created_at: line.created_at,
      settled_at: null,
      settlement_id: null,
      settlement_utr: null,
      order_id: line.order_id,
      method: line.method,
      card_network: line.card_network,
      card_type: line.card_type,
      international: line.international,
      dispute_id: null,
      description: '',
    };
    batch.lines.push(part2);
    addLineToSettlement(part2, settlementB);

    claimedLineIds.add(line.entity_id);
    claimedLineIds.add(part2.entity_id);
    picked += 1;

    const reason = `Payment split across settlements ${settlementA.settlement_id} and ${settlementB.settlement_id}.`;
    for (const l of [line, part2]) {
      log.push({
        record_id: recordId('settlement_line', l.entity_id),
        source: 'settlement_line',
        injected_case: 'partial_settlement',
        expected_link_ids: [settlementA.settlement_id, settlementB.settlement_id],
        expected_class: 'PARTIAL_SETTLEMENT',
        expected_decision: 'AUTO_RESOLVED',
        is_resolvable: true,
        expected_reason: reason,
      });
    }
  }
}

/** Case 5, split payout: one settlement arrives as two bank credits summing to its total. */
function injectSplitPayout(
  profile: MerchantProfile,
  rng: Rng,
  batch: GeneratedRecords,
  claimedSettlementIds: Set<string>,
  pendingBankLog: PendingBankEntry[],
  count: number
): void {
  const candidates = rng.shuffle(batch.settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id)));

  let picked = 0;
  for (const settlement of candidates) {
    if (picked >= count) break;
    const original = findBankLineForSettlement(batch.bankLines, settlement);
    if (!original) continue;

    batch.bankLines.splice(batch.bankLines.indexOf(original), 1);

    const splitBps = rng.int(3000, 7000);
    const creditA = toPaise(roundHalfUp(settlement.amount_paise * splitBps, 10_000));
    const creditB = toPaise(settlement.amount_paise - creditA);

    const bankA: BankLine = {
      line_no: 0, // finalizeBankStatement assigns the real value
      value_date: settlement.created_at,
      narration: fillNarrationTemplate(rng.pick(profile.narrationTemplates), settlement.utr_number, randomBankRef(rng)),
      ref_no: rng.bool(profile.bankRefNoBlankRate) ? null : randomBankRef(rng),
      debit_paise: toPaise(0),
      credit_paise: creditA,
      closing_balance_paise: toPaise(0), // recomputed by finalizeBankStatement
    };
    const bankB: BankLine = {
      ...bankA,
      narration: fillNarrationTemplate(rng.pick(profile.narrationTemplates), settlement.utr_number, randomBankRef(rng)),
      ref_no: rng.bool(profile.bankRefNoBlankRate) ? null : randomBankRef(rng),
      credit_paise: creditB,
    };

    batch.bankLines.push(bankA, bankB);
    claimedSettlementIds.add(settlement.settlement_id);
    picked += 1;

    const reason = `Settlement ${settlement.settlement_id} arrived as two separate bank credits summing to its full amount.`;
    for (const bankLine of [bankA, bankB]) {
      pendingBankLog.push({
        bankLine,
        entry: {
          source: 'bank',
          injected_case: 'split_payout',
          expected_link_ids: [settlement.settlement_id],
          expected_class: 'SPLIT_PAYOUT',
          expected_decision: 'AUTO_RESOLVED',
          is_resolvable: true,
          expected_reason: reason,
        },
      });
    }
  }
}

/** Case 6, aggregated credit: two settlements collapsed into one bank credit, narration naming only one UTR. */
function injectAggregatedCredit(
  profile: MerchantProfile,
  rng: Rng,
  batch: GeneratedRecords,
  claimedSettlementIds: Set<string>,
  pendingBankLog: PendingBankEntry[],
  pairCount: number
): void {
  const available = rng.shuffle(batch.settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id)));
  const used = new Set<string>();

  let pairsDone = 0;
  for (let i = 0; i < available.length && pairsDone < pairCount; i += 1) {
    const a = available[i];
    if (used.has(a.settlement_id)) continue;
    const bankA = findBankLineForSettlement(batch.bankLines, a);
    if (!bankA) continue;

    // Only pair within Pass 3's own ±2-day pool window (SETL_BLUEPRINT.md
    // section 10) — a pair further apart than that constructs an
    // aggregated credit the engine can never actually detect. Skip this
    // injection attempt rather than force a distant pair: scan the rest
    // of the shuffled pool for the first still-unused, in-window partner.
    let b: Settlement | undefined;
    let bankB: BankLine | undefined;
    for (let j = i + 1; j < available.length; j += 1) {
      const candidate = available[j];
      if (used.has(candidate.settlement_id)) continue;
      if (Math.abs(daysBetweenIST(a.created_at, candidate.created_at)) > 2) continue;
      const candidateBank = findBankLineForSettlement(batch.bankLines, candidate);
      if (!candidateBank) continue;
      b = candidate;
      bankB = candidateBank;
      break;
    }
    if (!b || !bankB) continue; // no valid in-window partner for `a` in the current pool

    used.add(a.settlement_id);
    used.add(b.settlement_id);

    batch.bankLines.splice(batch.bankLines.indexOf(bankA), 1);
    batch.bankLines.splice(batch.bankLines.indexOf(bankB), 1);

    // Mentions only A's UTR — that omission is the point of this case.
    const narration = fillNarrationTemplate(rng.pick(profile.narrationTemplates), a.utr_number, randomBankRef(rng));
    const laterDate = a.created_at.getTime() >= b.created_at.getTime() ? a.created_at : b.created_at;

    const merged: BankLine = {
      line_no: 0,
      value_date: laterDate,
      narration,
      ref_no: rng.bool(profile.bankRefNoBlankRate) ? null : randomBankRef(rng),
      debit_paise: toPaise(0),
      credit_paise: toPaise(a.amount_paise + b.amount_paise),
      closing_balance_paise: toPaise(0),
    };
    batch.bankLines.push(merged);
    claimedSettlementIds.add(a.settlement_id);
    claimedSettlementIds.add(b.settlement_id);
    pairsDone += 1;

    pendingBankLog.push({
      bankLine: merged,
      entry: {
        source: 'bank',
        injected_case: 'aggregated_credit',
        expected_link_ids: [a.settlement_id, b.settlement_id],
        expected_class: 'MATCHED_EXACT',
        expected_decision: 'AUTO_RESOLVED',
        is_resolvable: true,
        expected_reason: `One bank credit covers two settlements: ${a.settlement_id} and ${b.settlement_id}.`,
      },
    });
  }
}

/** Case 7, duplicate credit: the bank posts the same UTR and amount twice, one day apart. */
function injectDuplicateCredit(
  rng: Rng,
  batch: GeneratedRecords,
  claimedSettlementIds: Set<string>,
  pendingBankLog: PendingBankEntry[],
  count: number
): void {
  const candidates = rng.shuffle(batch.settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id)));

  let picked = 0;
  for (const settlement of candidates) {
    if (picked >= count) break;
    const original = findBankLineForSettlement(batch.bankLines, settlement);
    if (!original) continue;

    // The original is left untouched — it resolves normally and is
    // logged as MATCHED_EXACT by the exact-match sweep, unaffected by
    // this. Only the copy is the anomaly.
    const duplicate: BankLine = {
      ...original,
      line_no: 0,
      value_date: new Date(original.value_date.getTime() + 86_400_000),
      ref_no: randomBankRef(rng), // its own posting reference; same narration/UTR/amount
      closing_balance_paise: toPaise(0),
    };
    batch.bankLines.push(duplicate);
    claimedSettlementIds.add(settlement.settlement_id);
    picked += 1;

    pendingBankLog.push({
      bankLine: duplicate,
      entry: {
        source: 'bank',
        injected_case: 'duplicate_credit',
        expected_link_ids: [settlement.settlement_id],
        expected_class: 'DUPLICATE_CREDIT',
        expected_decision: 'NEEDS_REVIEW',
        is_resolvable: true,
        expected_reason: `Same UTR and amount as the bank credit for settlement ${settlement.settlement_id}, posted a day later — the bank likely posted it twice.`,
      },
    });
  }
}

/**
 * Case 8, missing in bank: the settlement says money was paid out; the
 * bank shows nothing. Genuinely unresolvable — is_resolvable: false, per
 * section 8's "cases 8, 13 and 14 give you roughly 14 genuinely
 * unresolvable records." Logged against the SETTLEMENT itself (source
 * 'settlement'): nothing in orders/settlement_lines/bank_lines was
 * deleted, so there is no other record to carry this finding.
 */
function injectMissingInBank(
  batch: GeneratedRecords,
  claimedSettlementIds: Set<string>,
  log: GroundTruthRecord[],
  count: number
): void {
  const candidates = batch.settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id));

  let picked = 0;
  for (const settlement of candidates) {
    if (picked >= count) break;
    const bankLine = findBankLineForSettlement(batch.bankLines, settlement);
    if (!bankLine) continue;

    batch.bankLines.splice(batch.bankLines.indexOf(bankLine), 1);
    claimedSettlementIds.add(settlement.settlement_id);
    picked += 1;

    log.push({
      record_id: recordId('settlement', settlement.settlement_id),
      source: 'settlement',
      injected_case: 'missing_in_bank',
      expected_link_ids: [],
      expected_class: 'MISSING_IN_BANK',
      expected_decision: 'UNRESOLVED',
      is_resolvable: false,
      expected_reason: `Settlement ${settlement.settlement_id} (UTR ${settlement.utr_number}) shows as processed but no matching bank credit was found.`,
    });
  }
}

/**
 * Case 10, rounding residual: perturb a settlement's HEADER amount by
 * 1-99 paise without touching its lines. This is the one mutation that
 * deliberately breaks Pass 4's internal-balance identity — that is the
 * point, and it auto-resolves via write-off rather than escalating.
 */
function injectRoundingResidual(
  rng: Rng,
  batch: GeneratedRecords,
  claimedSettlementIds: Set<string>,
  log: GroundTruthRecord[],
  count: number
): void {
  const candidates = rng.shuffle(batch.settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id)));

  let picked = 0;
  for (const settlement of candidates) {
    if (picked >= count) break;

    const magnitude = rng.int(1, 99);
    const residual = rng.bool() ? magnitude : -magnitude;
    settlement.amount_paise = toPaise(settlement.amount_paise + residual);
    claimedSettlementIds.add(settlement.settlement_id);
    picked += 1;

    log.push({
      record_id: recordId('settlement', settlement.settlement_id),
      source: 'settlement',
      injected_case: 'rounding_residual',
      expected_link_ids: [],
      expected_class: 'ROUNDING_RESIDUAL',
      expected_decision: 'AUTO_RESOLVED',
      is_resolvable: true,
      expected_reason: `Settlement header is off by ${formatPaise(toPaise(magnitude))} from its own lines — a rounding residual, written off automatically.`,
    });
  }
}

/**
 * Change a line's fee/GST and propagate the delta into its settlement's
 * header, so Pass 4's identity (header == sum of lines) still holds on
 * the NEW, incorrect fee — an overcharge is a real, consistently
 * propagated financial fact, wrong only relative to the rate card.
 */
function applyFeeOverride(line: SettlementLine, settlement: Settlement, newFee: Paise, newTax: Paise): void {
  const deltaFee = newFee - line.fee_paise;
  const deltaTax = newTax - line.tax_paise;
  line.fee_paise = newFee;
  line.tax_paise = newTax;
  line.credit_paise = toPaise(line.credit_paise - deltaFee - deltaTax);
  settlement.fees_paise = toPaise(settlement.fees_paise + deltaFee);
  settlement.tax_paise = toPaise(settlement.tax_paise + deltaTax);
  settlement.amount_paise = toPaise(settlement.amount_paise - deltaFee - deltaTax);
}

/** Case 11, fee overcharge: a UPI or debit-card line billed at the domestic-credit-card rate. */
function injectFeeOvercharge(
  profile: MerchantProfile,
  rng: Rng,
  batch: GeneratedRecords,
  claimedLineIds: Set<string>,
  claimedSettlementIds: Set<string>,
  log: GroundTruthRecord[],
  count: number
): void {
  const settlementById = new Map(batch.settlements.map((s) => [s.settlement_id, s]));
  const candidates = rng.shuffle(
    batch.lines.filter(
      (l) =>
        l.type === 'payment' &&
        l.settlement_id &&
        !claimedLineIds.has(l.entity_id) &&
        // Never mutate a settlement a bank-level injector (split/aggregate/
        // duplicate/corrupted-narration/missing-in-bank) already claimed —
        // applyFeeOverride below changes settlement.amount_paise, and that
        // settlement's bank line was already fixed by the earlier mutation
        // using the OLD amount. Stacking on top of it would silently
        // corrupt an already-constructed case.
        !claimedSettlementIds.has(l.settlement_id) &&
        (l.method === 'upi' || l.card_type === 'debit')
    )
  );

  let picked = 0;
  for (const line of candidates) {
    if (picked >= count) break;
    const settlement = settlementById.get(line.settlement_id!);
    if (!settlement) continue;

    const wrong = computeFee(profile.rateCard, 'card', 'credit', false, line.amount_paise);
    applyFeeOverride(line, settlement, wrong.feePaise, wrong.gstPaise);
    claimedLineIds.add(line.entity_id);
    picked += 1;

    const order = batch.orders.find((o) => o.order_id === line.order_id);
    const cause = line.method === 'upi' ? 'UPI carries zero MDR, but this' : 'A debit card was billed at the credit-card rate; this';
    log.push({
      record_id: recordId('settlement_line', line.entity_id),
      source: 'settlement_line',
      injected_case: 'fee_overcharge',
      expected_link_ids: order ? [order.order_id] : [],
      expected_class: 'FEE_OVERCHARGE',
      expected_decision: 'NEEDS_REVIEW',
      is_resolvable: true,
      expected_reason: `${cause} line was charged ${formatPaise(wrong.feePaise)} in fees.`,
    });
  }
}

/**
 * Change a line's gross amount (and derived fee/GST/credit) and propagate
 * the delta into its settlement, the same way applyFeeOverride does for
 * a fee-only change.
 */
function applyAmountOverride(
  profile: MerchantProfile,
  line: SettlementLine,
  settlement: Settlement,
  newAmount: Paise
): void {
  if (!line.method) throw new Error(`applyAmountOverride: line ${line.entity_id} has no method`);
  const { feePaise, gstPaise } = computeFee(profile.rateCard, line.method, line.card_type, line.international, newAmount);
  const newCredit = toPaise(newAmount - feePaise - gstPaise);

  const deltaCredit = newCredit - line.credit_paise;
  const deltaFee = feePaise - line.fee_paise;
  const deltaTax = gstPaise - line.tax_paise;

  line.amount_paise = newAmount;
  line.fee_paise = feePaise;
  line.tax_paise = gstPaise;
  line.credit_paise = newCredit;

  settlement.amount_paise = toPaise(settlement.amount_paise + deltaCredit);
  settlement.fees_paise = toPaise(settlement.fees_paise + deltaFee);
  settlement.tax_paise = toPaise(settlement.tax_paise + deltaTax);
}

/**
 * Case 13, ambiguous match: two payments end up with identical amount and
 * date, both missing an order reference — genuinely unresolvable, the
 * system must refuse rather than guess. If this ever resolves to a link,
 * the system is broken (section 19, scenario 8's exact warning).
 */
function injectAmbiguousMatch(
  profile: MerchantProfile,
  rng: Rng,
  batch: GeneratedRecords,
  claimedLineIds: Set<string>,
  claimedSettlementIds: Set<string>,
  log: GroundTruthRecord[],
  pairCount: number
): void {
  const settlementById = new Map(batch.settlements.map((s) => [s.settlement_id, s]));
  const paymentByOrderId = new Map<string, SettlementLine>();
  for (const l of batch.lines) {
    if (l.type === 'payment' && l.order_id) paymentByOrderId.set(l.order_id, l);
  }

  const eligibleOrders = rng.shuffle(
    batch.orders.filter((o) => {
      if (o.order_status !== 'paid') return false;
      const line = paymentByOrderId.get(o.order_id);
      // Same guard as injectFeeOvercharge: orderB's line gets forced onto
      // orderA's amount via applyAmountOverride below, which mutates
      // settlementB.amount_paise. Never let that be a settlement a
      // bank-level injector already claimed and fixed a bank line for.
      return (
        !!line && !claimedLineIds.has(line.entity_id) && !!line.settlement_id && !claimedSettlementIds.has(line.settlement_id)
      );
    })
  );

  let pairsDone = 0;
  let i = 0;
  while (pairsDone < pairCount && i + 1 < eligibleOrders.length) {
    const orderA = eligibleOrders[i];
    const orderB = eligibleOrders[i + 1];
    i += 2;

    const lineA = paymentByOrderId.get(orderA.order_id)!;
    const lineB = paymentByOrderId.get(orderB.order_id)!;
    const settlementB = settlementById.get(lineB.settlement_id!);
    if (!settlementB) continue;

    // Force B to share A's amount and placement time — ORDER B's own
    // created_at too, not just its payment line's, or order B would show
    // a placement date days away from the shared capture day: a
    // temporally impossible tell (a payment can't capture before its
    // order exists) that would let a careful matcher break the tie by
    // elimination. Once order_id is blanked below, the two must be
    // genuinely indistinguishable by amount+date matching.
    orderB.order_amount_paise = orderA.order_amount_paise;
    orderB.created_at = orderA.created_at;
    applyAmountOverride(profile, lineB, settlementB, orderA.order_amount_paise);
    lineB.created_at = orderA.created_at;

    lineA.order_id = null;
    lineB.order_id = null;
    claimedLineIds.add(lineA.entity_id);
    claimedLineIds.add(lineB.entity_id);
    pairsDone += 1;

    const reason = `Two payments of ${formatPaise(orderA.order_amount_paise)} on the same day, both missing an order reference — no unique match exists.`;
    for (const line of [lineA, lineB]) {
      log.push({
        record_id: recordId('settlement_line', line.entity_id),
        source: 'settlement_line',
        injected_case: 'ambiguous_match',
        expected_link_ids: [],
        expected_class: 'UNRESOLVED',
        expected_decision: 'UNRESOLVED',
        is_resolvable: false,
        expected_reason: reason,
      });
    }
    // From the order side too: each order still exists, but which
    // settlement line is truly its own cannot be told apart from the
    // other's, so it is logged as unresolved rather than a false MATCHED_EXACT.
    for (const order of [orderA, orderB]) {
      log.push({
        record_id: recordId('order', order.order_id),
        source: 'order',
        injected_case: 'ambiguous_match',
        expected_link_ids: [],
        expected_class: 'UNRESOLVED',
        expected_decision: 'UNRESOLVED',
        is_resolvable: false,
        expected_reason: reason,
      });
    }
  }
}

/**
 * Mangle a UTR inside a narration: truncate its last 2 characters and
 * swap look-alike digits/letters (0->O, 1->l) — the exact style of
 * corruption section 8 shows ('1568176960vxp0rj' -> '1568176960vxp0',
 * '156817696OvxpOrj'). A naive regex may still extract SOMETHING, but it
 * will not match any real settlement UTR.
 */
function corruptUtrInNarration(narration: string, utr: string): string {
  const idx = narration.toLowerCase().indexOf(utr.toLowerCase());
  if (idx === -1) return narration;
  const mangled = utr.slice(0, utr.length - 2).replace(/0/g, 'O').replace(/1/g, 'l');
  return narration.slice(0, idx) + mangled + narration.slice(idx + utr.length);
}

/** Case 14, corrupted narration: a UTR mangled beyond regex recovery — unresolvable by design. */
function injectCorruptedNarration(
  rng: Rng,
  batch: GeneratedRecords,
  claimedSettlementIds: Set<string>,
  pendingBankLog: PendingBankEntry[],
  count: number
): void {
  const findUnclaimedSettlementFor = (bankLine: BankLine) =>
    batch.settlements.find(
      (s) => !claimedSettlementIds.has(s.settlement_id) && bankLine.narration.toLowerCase().includes(s.utr_number.toLowerCase())
    );

  const candidates = rng.shuffle(batch.bankLines.filter((b) => !!findUnclaimedSettlementFor(b)));

  let picked = 0;
  for (const bankLine of candidates) {
    if (picked >= count) break;
    const settlement = findUnclaimedSettlementFor(bankLine);
    if (!settlement) continue;

    bankLine.narration = corruptUtrInNarration(bankLine.narration, settlement.utr_number);
    bankLine.ref_no = null; // a corrupted narration line also tends to lack a usable ref
    claimedSettlementIds.add(settlement.settlement_id);
    picked += 1;

    pendingBankLog.push({
      bankLine,
      entry: {
        source: 'bank',
        injected_case: 'corrupted_narration',
        expected_link_ids: [],
        expected_class: 'UNRESOLVED',
        expected_decision: 'UNRESOLVED',
        is_resolvable: false,
        expected_reason: `Narration UTR is truncated and mangled; cannot be matched to settlement ${settlement.settlement_id} or any other with confidence.`,
      },
    });
  }
}

function injectAnomalies(
  profile: MerchantProfile,
  rng: Rng,
  batch: GeneratedRecords
): GroundTruthRecord[] {
  const log: GroundTruthRecord[] = [];
  const claimedLineIds = new Set<string>();
  const claimedSettlementIds = new Set<string>();
  const pendingBankLog: PendingBankEntry[] = [];
  const counts = tuningFor(profile);

  // Cases already produced by earlier generation steps (7, 8, 9) — logged
  // here, not mutated again.
  logRefundNettedCases(batch, log);
  logDisputeHoldCases(batch, log);
  logTdsCases(batch, log);
  logOpaqueAdjustmentCases(batch, log);

  // Matching-layer mutations. Settlement-line-level cases log immediately
  // (their record_id is a stable entity_id); bank-level cases defer to
  // pendingBankLog until finalizeBankStatement fixes line_no.
  injectTimingDifference(rng, batch, claimedLineIds, log, counts.timingDifference);
  injectPartialSettlement(profile, rng, batch, claimedLineIds, log, counts.partialSettlement);
  injectSplitPayout(profile, rng, batch, claimedSettlementIds, pendingBankLog, counts.splitPayout);
  injectAggregatedCredit(profile, rng, batch, claimedSettlementIds, pendingBankLog, counts.aggregatedCreditPairs);
  injectDuplicateCredit(rng, batch, claimedSettlementIds, pendingBankLog, counts.duplicateCredit);

  // corrupted_narration needs a settlement whose bank line still carries
  // a UTR to mangle; missing_in_bank and rounding_residual do not care
  // either way (missing_in_bank works via the amount fallback). Runs
  // first among the remaining settlement-claiming mutations so it is not
  // starved of UTR-carrying settlements by mutations that don't need one.
  injectCorruptedNarration(rng, batch, claimedSettlementIds, pendingBankLog, counts.corruptedNarration);

  // Detection-layer mutations, including the other two genuinely
  // unresolvable cases (8, 13) that give the project its honest
  // exception list.
  injectMissingInBank(batch, claimedSettlementIds, log, counts.missingInBank);
  injectRoundingResidual(rng, batch, claimedSettlementIds, log, counts.roundingResidual);
  injectFeeOvercharge(profile, rng, batch, claimedLineIds, claimedSettlementIds, log, counts.feeOvercharge);
  injectAmbiguousMatch(profile, rng, batch, claimedLineIds, claimedSettlementIds, log, counts.ambiguousMatchPairs);

  finalizeBankStatement(batch.bankLines);
  for (const { bankLine, entry } of pendingBankLog) {
    log.push({ ...entry, record_id: recordId('bank', bankLine.line_no) });
  }

  // Whatever nothing above claimed is a genuine exact match.
  logExactMatchCases(batch, log);

  return log;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function generateBatch(profile: MerchantProfile, seed: number): GeneratedBatch {
  const rng = new Rng(seed);

  const orders = generateOrders(profile, rng);
  const lines = generatePaymentsAndFees(profile, rng, orders);
  generateRefunds(profile, rng, orders, lines);
  generateDisputes(profile, rng, orders, lines);
  generateAdjustments(profile, rng, lines);
  const settlements = batchIntoSettlements(profile, rng, lines);
  const bankLines = generateBankLines(profile, rng, settlements);

  const records: GeneratedRecords = { orders, lines, settlements, bankLines };
  const groundTruthLog = injectAnomalies(profile, rng, records);

  return { ...records, groundTruthLog };
}

// --- CSV serialization ---
//
// Field names below match SETL_BLUEPRINT.md section 7 exactly. Money
// columns write the raw integer paise value — never formatPaise()'s
// '₹1,000.00' display form, which is for the UI, not interchange.

/** IST is UTC+05:30, year-round — no DST, so this offset is exact and permanent. */
const IST_OFFSET_MS = 19_800_000;

/** Full ISO8601 timestamp with an explicit +05:30 offset, e.g. '2026-03-02T06:39:07+05:30'. */
function formatISTDateTime(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = shifted.getUTCFullYear();
  const mm = pad(shifted.getUTCMonth() + 1);
  const dd = pad(shifted.getUTCDate());
  const hh = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const ss = pad(shifted.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:30`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\n') + '\n';
}

function ordersToCsv(orders: Order[]): string {
  const headers = [
    'order_id',
    'order_ref',
    'customer_ref',
    'order_amount_paise',
    'currency',
    'created_at',
    'order_status',
    'refund_issued_paise',
  ];
  const rows = orders.map((o) => [
    o.order_id,
    o.order_ref,
    o.customer_ref,
    String(o.order_amount_paise),
    o.currency,
    formatISTDateTime(o.created_at),
    o.order_status,
    String(o.refund_issued_paise),
  ]);
  return toCsv(headers, rows);
}

function settlementsToCsv(settlements: Settlement[]): string {
  const headers = ['settlement_id', 'amount_paise', 'fees_paise', 'tax_paise', 'utr_number', 'status', 'created_at'];
  const rows = settlements.map((s) => [
    s.settlement_id,
    String(s.amount_paise),
    String(s.fees_paise),
    String(s.tax_paise),
    s.utr_number,
    s.status,
    formatISTDateTime(s.created_at),
  ]);
  return toCsv(headers, rows);
}

function settlementLinesToCsv(lines: SettlementLine[]): string {
  const headers = [
    'entity_id',
    'type',
    'debit_paise',
    'credit_paise',
    'amount_paise',
    'fee_paise',
    'tax_paise',
    'on_hold',
    'settled',
    'created_at',
    'settled_at',
    'settlement_id',
    'settlement_utr',
    'order_id',
    'method',
    'card_network',
    'card_type',
    'international',
    'dispute_id',
    'description',
  ];
  const rows = lines.map((l) => [
    l.entity_id,
    l.type,
    String(l.debit_paise),
    String(l.credit_paise),
    String(l.amount_paise),
    String(l.fee_paise),
    String(l.tax_paise),
    String(l.on_hold),
    String(l.settled),
    formatISTDateTime(l.created_at),
    l.settled_at ? formatISTDateTime(l.settled_at) : '',
    l.settlement_id ?? '',
    l.settlement_utr ?? '',
    l.order_id ?? '',
    l.method ?? '',
    l.card_network ?? '',
    l.card_type ?? '',
    String(l.international),
    l.dispute_id ?? '',
    l.description,
  ]);
  return toCsv(headers, rows);
}

function bankLinesToCsv(bankLines: BankLine[]): string {
  const headers = ['line_no', 'value_date', 'narration', 'ref_no', 'debit_paise', 'credit_paise', 'closing_balance_paise'];
  const rows = bankLines.map((b) => [
    String(b.line_no),
    formatISTDate(b.value_date),
    b.narration,
    b.ref_no ?? '',
    String(b.debit_paise),
    String(b.credit_paise),
    String(b.closing_balance_paise),
  ]);
  return toCsv(headers, rows);
}

// batch_id tracks the BATCH designation from the db schema ('main' /
// 'holdout'), not the merchant profile name — the blueprint's own
// ground_truth.json example uses 'main-v1', not 'kiranakart-v1'. Prompt 06
// extends this map with bombayweave -> 'holdout' when that profile is added.
const BATCH_NAME_BY_PROFILE: Record<string, string> = { kiranakart: 'main', bombayweave: 'holdout' };

/**
 * Assemble ground_truth.json exactly as recorded during generation —
 * batch.groundTruthLog already holds one entry per record, written at
 * the moment each anomaly was injected. This function only summarizes
 * it into the totals block; it never re-derives anything from the CSVs.
 */
function buildGroundTruthFile(profile: MerchantProfile, seed: number, batch: GeneratedBatch): GroundTruthFile {
  const paymentLines = batch.lines.filter((l) => l.type === 'payment');
  const grossAmountPaise = paymentLines.reduce((sum, l) => sum + l.amount_paise, 0);
  const expectedFeePaise = paymentLines.reduce((sum, l) => sum + l.fee_paise, 0);
  const expectedGstPaise = paymentLines.reduce((sum, l) => sum + l.tax_paise, 0);

  const resolvable = batch.groundTruthLog.filter((r) => r.is_resolvable).length;
  const unresolvableByDesign = batch.groundTruthLog.filter((r) => !r.is_resolvable).length;

  const batchName = BATCH_NAME_BY_PROFILE[profile.name] ?? profile.name;

  return {
    batch_id: `${batchName}-v1`,
    seed,
    profile: profile.name,
    generated_at: new Date().toISOString(),
    records: batch.groundTruthLog,
    totals: {
      records: batch.groundTruthLog.length,
      resolvable,
      unresolvable_by_design: unresolvableByDesign,
      gross_amount_paise: grossAmountPaise,
      expected_fee_paise: expectedFeePaise,
      expected_gst_paise: expectedGstPaise,
    },
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const profile = getProfile(args.profile);

  console.log(`Generating batch: profile=${profile.name} seed=${args.seed} out=${args.out}`);

  const batch = generateBatch(profile, args.seed);
  const groundTruth = buildGroundTruthFile(profile, args.seed, batch);

  mkdirSync(args.out, { recursive: true });

  writeFileSync(join(args.out, 'orders.csv'), ordersToCsv(batch.orders));
  writeFileSync(join(args.out, 'settlements.csv'), settlementsToCsv(batch.settlements));
  writeFileSync(join(args.out, 'settlement_lines.csv'), settlementLinesToCsv(batch.lines));
  writeFileSync(join(args.out, 'bank_statement.csv'), bankLinesToCsv(batch.bankLines));
  writeFileSync(join(args.out, 'ground_truth.json'), JSON.stringify(groundTruth, null, 2) + '\n');

  console.log(
    `Generated: ${batch.orders.length} orders, ${batch.lines.length} settlement lines, ` +
      `${batch.settlements.length} settlements, ${batch.bankLines.length} bank lines, ` +
      `${batch.groundTruthLog.length} ground-truth entries ` +
      `(${groundTruth.totals.resolvable} resolvable, ${groundTruth.totals.unresolvable_by_design} unresolvable by design).`
  );
  console.log(
    `Wrote orders.csv, settlements.csv, settlement_lines.csv, bank_statement.csv, ground_truth.json to ${args.out}`
  );
}

main();
