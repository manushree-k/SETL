// Tests for lib/normalize/narration.ts, per section 19 of the blueprint
// and prompt 07's own acceptance criteria: at least 8 templates,
// including two that must fail to parse.
//
// Fixtures below cover both bank house styles used in the dataset
// (kiranakart's HDFC-style, bombayweave's ICICI/Axis-style) and both
// flavours of "correctly refuses to guess": a UTR genuinely absent from
// the narration, and a UTR present but mangled beyond recognition
// (section 8's own corruption style — truncated, with 0->O / 1->l
// substitution). An over-greedy regex that "successfully" extracts a
// truncated or mangled UTR is worse than one that fails outright, per
// the blueprint's explicit warning — several cases here exist
// specifically to catch that failure mode.

import { describe, expect, it } from 'vitest';
import { extractUtr } from '../lib/normalize/narration';

const UTR = '8659945258yqimbl';
const UTR_UPPER = UTR.toUpperCase();

describe('extractUtr', () => {
  // --- Templates where the UTR is cleanly isolated by separators: must succeed ---

  it('extracts a UTR isolated by hyphens (kiranakart HDFC style)', () => {
    expect(extractUtr(`NEFT-RAZORPAY SOFTWARE PVT LTD-${UTR}-HDFC`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  it('extracts a UTR isolated by slashes', () => {
    expect(extractUtr(`UPI/SETTLEMENT/${UTR}/RAZORPAY`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  it('extracts a UTR isolated by spaces', () => {
    expect(extractUtr(`NEFT INWARD ${UTR} RAZORPAY SOFTWARE PRIVATE LIMI`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  it('extracts a UTR isolated by asterisks', () => {
    expect(extractUtr(`BY TRANSFER-NEFT*HDFC0000060*${UTR}*RAZORPAY`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  it('extracts an uppercase UTR (the {UTR_UPPER} template family)', () => {
    expect(extractUtr(`NEFT CR-HDFC0000060-RAZORPAY SOFTWA-${UTR_UPPER}-`)).toEqual({
      utr: UTR_UPPER,
      parse_source: 'regex',
    });
  });

  it('extracts a UTR isolated by a slash, ICICI/Axis style (bombayweave)', () => {
    expect(extractUtr(`RTGS/${UTR}/RAZORPAY SOFTWARE PVT LTD/ICICI`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  it('extracts a UTR at the end of the narration', () => {
    expect(extractUtr(`TRANSFER FROM RAZORPAY SOFTWARE-${UTR}`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  it('extracts the real UTR even when a shorter reference token is also present', () => {
    // The reference token (10 chars) and a bank code (11 chars) both
    // fall outside the exact 16-character UTR shape, so only the UTR
    // itself is a plausible candidate here — this template looks harder
    // than it is.
    expect(extractUtr(`NEFT/46VXPPSHYL/RAZORPAYSOFT/HDFC0000060/${UTR}`)).toEqual({
      utr: UTR,
      parse_source: 'regex',
    });
  });

  // --- Must fail: no UTR present at all ---

  it('defers when the narration carries no UTR, only a short reference token', () => {
    const result = extractUtr('IMPS/P2A/46VXPPSHYL/RAZORPAY/SETTLEMENT');
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  it('defers when the narration carries no UTR (ICICI/Axis style)', () => {
    const result = extractUtr('IMPS-46VXPPSHYL-RAZORPAY SOFTWARE-AXIS BANK');
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  // --- Must fail: UTR present but genuinely corrupted ---

  it('defers on a UTR glued directly to the word "UTR" with no separator', () => {
    // 'UTR' + the 16-char UTR forms one 19-character run with no internal
    // word boundary — length-plausible as a whole, but its shape does not
    // start with digits, so it correctly fails the shape check.
    const result = extractUtr(`RTGS CR RAZORPAYSOFT UTR${UTR}`);
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  it('defers on a UTR glued directly to trailing bank-code text with no separator', () => {
    // UTR + 'HDFC0000060' forms one 27-character run — too long to match
    // the UTR shape at all, so nothing is extracted (not a truncated or
    // wrong substring of it).
    const result = extractUtr(`RAZORPAY SETTLEMENT ${UTR}HDFC0000060`);
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  it('defers on a truncated UTR (section 8\'s own corruption example, cleanly separated)', () => {
    // '1568176960vxp0rj' truncated to '1568176960vxp0' — 14 characters,
    // isolated by hyphens so it IS a well-bounded candidate token. It
    // must still be rejected: accepting a syntactically-plausible but
    // wrong-length token here would be the over-greedy-regex failure the
    // blueprint explicitly warns is worse than failing outright.
    const result = extractUtr('NEFT-RAZORPAY SOFTWARE PVT LTD-1568176960vxp0-HDFC');
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  it('defers on a UTR mangled with 0->O and 1->l substitution (section 8\'s other corruption style)', () => {
    // '1568176960vxp0rj' -> '156817696OvxpOrj', section 8's own example.
    const result = extractUtr('NEFT CR-HDFC0000060-RAZORPAY SOFTWA-156817696OvxpOrj-');
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  it('defers on this generator\'s actual combined corruption (truncate + substitute), from a real committed narration', () => {
    // Taken directly from data/main/bank_statement.csv's own corrupted_narration case.
    const result = extractUtr('TPT-8659945258yqim-RAZORPAY-HDFC BANK LTD');
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  // --- Edge cases ---

  it('defers on an empty narration', () => {
    const result = extractUtr('');
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });

  it('defers when two plausible-shaped UTRs both appear (genuine ambiguity)', () => {
    const otherUtr = '1234567890abcdef';
    const result = extractUtr(`NEFT-${UTR}-AND-ALSO-${otherUtr}-HDFC`);
    expect(result.parse_source).toBe('pending_llm');
    expect(result.utr).toBeNull();
  });
});
