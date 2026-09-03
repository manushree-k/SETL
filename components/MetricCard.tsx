import { Card, CardContent } from "./ui/card";

export function MetricCard({ title, value, subtitle, valueClass = "", accent = "" }: { title: string; value: string; subtitle?: string; valueClass?: string; accent?: string }) {
  return (
    <Card className="group relative overflow-hidden border bg-card hover:shadow-[0_8px_30px_rgba(10,10,11,0.06)] transition-all duration-300">
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${accent || "bg-[var(--foreground)]"} opacity-60 group-hover:opacity-100 transition-opacity`} />
      <CardContent className="p-4 pl-5">
        <div className="text-[11px] tracking-[0.14em] uppercase font-medium text-muted-foreground">{title}</div>
        <div className={`mt-2 font-display text-2xl leading-none tracking-tight ${valueClass}`}>{value}</div>
        {subtitle && <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}
