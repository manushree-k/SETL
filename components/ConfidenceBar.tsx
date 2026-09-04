"use client";

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.86 ? "bg-green-600" : value >= 0.5 ? "bg-amber-500" : "bg-red-600";
  return (
    <div className="w-20 h-2 rounded-full bg-muted overflow-hidden" title={`${pct}%`}>
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
