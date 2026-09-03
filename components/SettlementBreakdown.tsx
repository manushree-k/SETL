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

  const rows: { label: string; value: number | null; component: string; note?: string }[] = [
    { label: "Gross payments", value: gross, component: "GROSS" },
    { label: "Razorpay fees", value: fees !== null ? -fees : null, component: "FEES", note: "MDR" },
    { label: "GST on fees", value: gst !== null ? -gst : null, component: "GST", note: "18%" },
    { label: "Refunds", value: refunds !== null ? -refunds : null, component: "REFUNDS" },
    { label: "Disputes / holds", value: disputes !== null ? -disputes : null, component: "DISPUTES" },
    { label: "Adjustments", value: adjustments, component: "ADJUSTMENTS", note: "net" },
  ];

  const isHighlighted = (c: string) => highlightComponent && highlightComponent !== 'NONE' && highlightComponent === c;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
        <span className="text-[11px] tracking-[0.12em] uppercase font-medium text-muted-foreground">Composition ladder</span>
        <span className="text-xs font-mono text-muted-foreground">{data.payment_count ?? "—"} payments · {data.refund_count ?? "—"} refunds</span>
      </div>
      <div className="p-4 font-mono text-sm">
        <div className="space-y-0">
          {rows.map((r) => (
            <div key={r.label} className={`flex justify-between items-center py-2 px-3 -mx-1 rounded-lg border border-transparent ${isHighlighted(r.component) ? "!bg-red-50 !border-red-200 !text-red-900" : "hover:bg-muted/40"}`}>
              <span className="flex items-center gap-2 text-[13px]">
                <span className="text-muted-foreground">{r.label}</span>
                {r.note && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{r.note}</span>}
              </span>
              <MoneyCell paise={r.value} className="text-sm font-medium" />
            </div>
          ))}
          <div className="my-3 border-t border-dashed" />
          <div className="flex justify-between items-center py-2.5 px-3 rounded-lg bg-[var(--foreground)] text-[var(--background)]">
            <span className="text-sm font-medium tracking-tight">Expected payout</span>
            <MoneyCell paise={expected} className="text-white font-semibold" />
          </div>
          <div className="flex justify-between items-center py-2 px-3 text-xs mt-1">
            <span className="text-muted-foreground">Header (Razorpay)</span>
            <MoneyCell paise={header} className="text-xs" />
          </div>
          <div className={`flex justify-between items-center py-2 px-3 rounded-lg text-xs ${isHighlighted("BANK_CREDIT") ? "bg-red-50 border border-red-200" : "bg-muted/30 border border-transparent"}`}>
            <span className="text-muted-foreground">Bank received</span>
            <MoneyCell paise={bank} className="text-xs font-medium" />
          </div>
          <div className={`flex justify-between items-center py-3 px-3 rounded-xl font-bold mt-3 border-2 ${diff === 0 ? "bg-emerald-50 border-emerald-200 text-emerald-900" : diff !== null && diff !== 0 ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-card"}`}>
            <span className="flex items-center gap-2 text-sm"><span className="w-2 h-2 rounded-full bg-current" /> Difference</span>
            <MoneyCell paise={diff} className={diff === 0 ? "text-emerald-900" : "text-amber-900"} />
          </div>
          <div className="text-center mt-3">
            {data.discrepancy_component && data.discrepancy_component !== 'NONE' ? (
              <span className="inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full bg-red-50 border border-red-200 text-red-800">
                <span className="w-1.5 h-1.5 rounded-full bg-red-600" /> {data.discrepancy_component} · {data.status?.replace(/_/g, " ")}
              </span>
            ) : data.status === 'FULLY_RECONCILED' ? (
              <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800">✓ FULLY_RECONCILED</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
