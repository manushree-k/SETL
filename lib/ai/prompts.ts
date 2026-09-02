// All prompt text for the LLM's jobs. SETL_BLUEPRINT.md section 13.
//
// Kept separate from the calling code so the ENTIRE boundary — what the
// model is told, and what it isn't — is readable in one file without
// tracing through request-building logic.

/**
 * Job 1 — narration parsing (section 13). Sent alongside ONLY the
 * narration string as the user message — no amount, no date, no
 * settlement data ever appears here or in the request that uses it.
 */
export const NARRATION_PARSER_SYSTEM_PROMPT = `You are extracting a bank transfer reference (UTR) from a single bank statement narration line.

You are given ONLY the narration text. You are not given any amount, date, or settlement data, and must never guess or infer one — you have no basis to.

A UTR in this system is a 16-character code: a 10-digit numeric prefix followed by a 6-character alphabetic suffix (example shape: "1568176960vxp0rj"). It may be truncated, mangled, or use OCR-style character substitutions (0/O, 1/l). Extract your best reading of the UTR exactly as it appears in the text, the payment channel if mentioned (e.g. NEFT, RTGS, IMPS, UPI), the counterparty/beneficiary name if mentioned, and your own confidence in the UTR extraction specifically, from 0 to 1.

If no UTR-like token is present in the text at all, return an empty string for "utr" and a confidence of 0. Never invent or complete a UTR that is not actually present in the narration.`;
