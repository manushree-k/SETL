// Rate cards: MDR (Merchant Discount Rate) per payment method, and GST on
// that fee. Section 8 of the blueprint.
//
// computeFee() here is the SAME function the generator uses to produce
// fee_paise/tax_paise and that Pass 6 (prompt 09) will reuse to recompute
// the expected fee and flag overcharges. Sharing one function instead of
// two independent implementations means the generator's "correct" fees
// and the auditor's "expected" fees can never drift apart by construction.

import type { CardType, PaymentMethod, RateCard, RateCardTier } from './types';
import { roundHalfUp, toPaise, type Paise } from './money';

/**
 * Main profile ("kiranakart") rate card. UPI carries zero MDR in India —
 * that is a real rule, not a generator convenience, and it is what makes
 * a UPI line charged at card rates a genuine, detectable FEE_OVERCHARGE
 * (injected case 11) rather than an arbitrary mutation.
 */
export const KIRANAKART_RATE_CARD: RateCard = {
  gstBps: 1800, // 18% GST on the fee
  upi: { type: 'bps', value: 0 },
  cardDomesticDebit: { type: 'bps', value: 90 },
  cardDomesticCredit: { type: 'bps', value: 200 },
  cardInternational: { type: 'bps', value: 300 },
  netbanking: { type: 'bps', value: 190 },
  wallet: { type: 'bps', value: 200 },
};

/**
 * Resolve which tier of a rate card applies to a line, given its method
 * and (for cards) card type and international flag.
 *
 * Throws for a card line missing cardType — that combination should never
 * occur in valid data, and failing loudly here is preferable to silently
 * defaulting to a rate that was never actually charged.
 */
export function lookupTier(
  rateCard: RateCard,
  method: PaymentMethod,
  cardType: CardType | null,
  international: boolean
): RateCardTier {
  switch (method) {
    case 'upi':
      return rateCard.upi;
    case 'netbanking':
      return rateCard.netbanking;
    case 'wallet':
      return rateCard.wallet;
    case 'card':
      if (international) return rateCard.cardInternational;
      if (cardType === 'debit') return rateCard.cardDomesticDebit;
      if (cardType === 'credit') return rateCard.cardDomesticCredit;
      throw new Error(
        `lookupTier: a card line needs cardType to be 'credit' or 'debit', received ${String(cardType)}.`
      );
  }
}

/** The fee for one tier applied to one gross amount. bps and flat tiers both go through roundHalfUp or an integer paise value — never a bare multiply/divide outside that helper. */
function tierFee(tier: RateCardTier, amountPaise: number): Paise {
  if (tier.type === 'flat') return toPaise(tier.value);
  return toPaise(roundHalfUp(amountPaise * tier.value, 10000));
}

export interface FeeResult {
  feePaise: Paise;
  gstPaise: Paise;
}

/**
 * Compute the fee and GST-on-fee for one payment line, in integer paise.
 *
 *     fee = roundHalfUp(amount_paise * bps, 10000)     — or a flat value
 *     gst = roundHalfUp(fee * gstBps, 10000)           — 18% of the fee
 *
 * Both the generator (to produce "correct" fees) and Pass 6 (to recompute
 * "expected" fees and flag deltas) call this same function.
 */
export function computeFee(
  rateCard: RateCard,
  method: PaymentMethod,
  cardType: CardType | null,
  international: boolean,
  amountPaise: number
): FeeResult {
  const tier = lookupTier(rateCard, method, cardType, international);
  const feePaise = tierFee(tier, amountPaise);
  const gstPaise = toPaise(roundHalfUp(feePaise * rateCard.gstBps, 10000));
  return { feePaise, gstPaise };
}
