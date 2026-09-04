"use client";
import { MoneyCell } from "./MoneyCell";

export function TieOutStrip({ gross, fees, gst, refunds, expected, bank, diff }: {
  gross: number; fees: number; gst: number; refunds: number; expected: number; bank: number | null; diff: number | null;
}) {
  const ok = diff === 0;
  return (
    <div className="flex items-center gap-2 text-xs font-mono overflow-x-auto py-2">
      <span className="whitespace-nowrap"><MoneyCell paise={gross} className="font-normal" /> gross</span>
      <span className="text-muted-foreground">−</span>
      <span><MoneyCell paise={fees} /> fees</span>
      <span className="text-muted-foreground">−</span>
      <span><MoneyCell paise={gst} /> GST</span>
      <span className="text-muted-foreground">−</span>
      <span><MoneyCell paise={refunds} /> refunds</span>
      <span className="text-muted-foreground">=</span>
      <span className="font-semibold"><MoneyCell paise={expected} /></span>
      <span className="text-muted-foreground">vs bank</span>
      <span><MoneyCell paise={bank} /></span>
      <span className={`px-2 py-0.5 rounded-full border text-xs font-bold ${ok ? "bg-green-100 border-green-300 text-green-800" : "bg-amber-100 border-amber-300 text-amber-800"}`}>
        Δ <MoneyCell paise={diff} className={ok ? "text-green-800" : "text-amber-800"} /> {ok ? "✓" : ""}
      </span>
    </div>
  );
}
