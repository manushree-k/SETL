import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function MetricCard({ title, value, subtitle, valueClass = "" }: { title: string; value: string; subtitle?: string; valueClass?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}
