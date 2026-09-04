"use client";
import { formatPaise } from "@/lib/money";

export function MoneyCell({ paise, className = "" }: { paise: number | null | undefined; className?: string }) {
  if (paise === null || paise === undefined) return <span className={`font-mono tabular-nums text-muted-foreground ${className}`}>—</span>;
  const formatted = formatPaise(paise as unknown as Parameters<typeof formatPaise>[0]);
  const negative = paise < 0;
  return (
    <span className={`font-mono tabular-nums ${negative ? "text-red-600" : ""} ${className}`}>
      {formatted}
    </span>
  );
}
