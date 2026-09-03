"use client";

const COLORS: Record<string, string> = {
  MATCHED_EXACT: "bg-green-100 text-green-800 border-green-200",
  FEE_DEDUCTION: "bg-blue-100 text-blue-800 border-blue-200",
  REFUND_NETTED: "bg-purple-100 text-purple-800 border-purple-200",
  DISPUTE_HOLD: "bg-amber-100 text-amber-800 border-amber-200",
  DUPLICATE_CREDIT: "bg-red-100 text-red-800 border-red-200",
  MISSING_IN_BANK: "bg-red-100 text-red-800 border-red-200",
  MISSING_IN_LEDGER: "bg-red-100 text-red-800 border-red-200",
  AMOUNT_MISMATCH: "bg-orange-100 text-orange-800 border-orange-200",
  FEE_OVERCHARGE: "bg-orange-100 text-orange-800 border-orange-200",
  ROUNDING_RESIDUAL: "bg-gray-100 text-gray-800 border-gray-200",
  UNRESOLVED: "bg-zinc-900 text-white",
  PARTIAL_SETTLEMENT: "bg-cyan-100 text-cyan-800 border-cyan-200",
  SPLIT_PAYOUT: "bg-cyan-100 text-cyan-800 border-cyan-200",
  TIMING_DIFFERENCE: "bg-indigo-100 text-indigo-800 border-indigo-200",
};

export function ExceptionBadge({ klass, className = "" }: { klass: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${COLORS[klass] ?? "bg-muted text-muted-foreground"} ${className}`}>
      {klass}
    </span>
  );
}
