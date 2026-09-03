"use client";
import { MoneyCell } from "./MoneyCell";

export interface SettlementBreakdownData {
  gross_payments_paise?: number; gross_payments?: number;
  fees_total_paise?: number; fees_total?: number;
  gst_total_paise?: number; gst_total?: number;
  refunds_total_paise?: number; refunds_total?: number;
  disputes_total_paise?: number; disputes_total?: number;
  adjustments_net_paise?: number; adjustments_net?: number;
  expected_payout_paise?: number; expected_payout?: number;
  header_amount_paise?: number; header_amount?: number;
  bank_credit_total_paise?: number | null; bank_credit_total?: number | null;
  diff_expected_vs_header_paise?: number; diff_expected_vs_header?: number;
  diff_header_vs_bank_paise?: number | null; diff_header_vs_bank?: number | null;
  diff_total_paise?: number | null; diff_total?: number | null;
  status?: string;
  discrepancy_component?: string;
  payment_count?: number;
  refund_count?: number;
}

function pickPaise(d: SettlementBreakdownData, a: string, b: string): number | null {
  const v = (d as Record<string, unknown>)[a] ?? (d as Record<string, unknown>)[b];
  return typeof v === 'number' ? v : null;
}

export function SettlementBreakdown({ data, highlightComponent }: { data: SettlementBreakdownData; highlightComponent?: string }) {
  const gross = pickPaise(data, 'gross_payments_paise', 'gross_payments');
  const fees = pickPaise(data, 'fees_total_paise', 'fees_total');
  const gst = pickPaise(data, 'gst_total_paise', 'gst_total');
  const refunds = pickPaise(data, 'refunds_total_paise', 'refunds_total');
  const disputes = pickPaise(data, 'disputes_total_paise', 'disputes_total');
  const adjustments = pickPaise(data, 'adjustments_net_paise', 'adjustments_net');
  const expected = pickPaise(data, 'expected_payout_paise', 'expected_payout');
  const header = pickPaise(data, 'header_amount_paise', 'header_amount');
  const bank = pickPaise(data, 'bank_credit_total_paise', 'bank_credit_total');
  const diff = pickPaise(data, 'diff_total_paise', 'diff_total');

  const rows: { label: string; value: number | null; component: string; isDiff?: boolean }[] = [
    { label: "Gross payments", value: gross, component: "GROSS" },
    { label: "− Fees (MDR)", value: fees !== null ? -fees : null, component: "FEES" },
    { label: "− GST on fees", value: gst !== null ? -gst : null, component: "GST" },
    { label: "− Refunds", value: refunds !== null ? -refunds : null, component: "REFUNDS" },
    { label: "− Disputes / holds", value: disputes !== null ? -disputes : null, component: "DISPUTES" },
    { label: "± Adjustments (net)", value: adjustments, component: "ADJUSTMENTS" },
  ];

  const isHighlighted = (c: string) => highlightComponent && highlightComponent !== 'NONE' && highlightComponent === c;

  return (
    <div className="rounded-lg border bg-card p-4 font-mono text-sm">
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className={`flex justify-between py-0.5 px-2 rounded ${isHighlighted(r.component) ? "bg-red-50 border border-red-200 text-red-900" : ""}`}>
            <span className="text-muted-foreground">{r.label}</span>
            <MoneyCell paise={r.value} className="font-medium" />
          </div>
        ))}
        <div className="border-t my-2" />
        <div className="flex justify-between py-1 px-2 font-semibold">
          <span>Expected payout</span>
          <MoneyCell paise={expected} />
        </div>
        <div className="flex justify-between py-1 px-2 text-xs">
          <span className="text-muted-foreground">Header (Razorpay)</span>
          <MoneyCell paise={header} className="text-xs" />
        </div>
        <div className={`flex justify-between py-1 px-2 text-xs ${isHighlighted("BANK_CREDIT") ? "bg-red-50 border border-red-200 rounded" : ""}`}>
          <span className="text-muted-foreground">Bank received</span>
          <MoneyCell paise={bank} className="text-xs" />
        </div>
        <div className={`flex justify-between py-2 px-2 rounded font-bold border-t mt-2 ${diff === 0 ? "bg-green-50 border-green-200 text-green-800" : diff !== null && diff !== 0 ? "bg-amber-50 border-amber-200" : ""}`}>
          <span>Difference</span>
          <MoneyCell paise={diff} />
        </div>
        {data.discrepancy_component && data.discrepancy_component !== 'NONE' && (
          <div className="text-xs text-center text-muted-foreground mt-1">
            Component: <span className="font-semibold text-foreground">{data.discrepancy_component}</span> {data.status && `· ${data.status.replace(/_/g, " ")}`}
          </div>
        )}
        {data.status === 'FULLY_RECONCILED' && <div className="text-xs text-center text-green-700 mt-1">✓ FULLY_RECONCILED</div>}
      </div>
    </div>
  );
}
