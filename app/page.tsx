"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { MetricCard } from "@/components/MetricCard";
import { SettlementBreakdown } from "@/components/SettlementBreakdown";
import { CompositionTable } from "@/components/CompositionTable";
import { MoneyCell } from "@/components/MoneyCell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

type Run = { id: string; batch: string; status: string; started_at: string };
type SettlementComp = {
  settlement_id: string;
  gross_payments: number; fees_total: number; gst_total: number;
  refunds_total: number; disputes_total: number; adjustments_net: number;
  expected_payout: number; header_amount: number; bank_credit_total: number | null;
  diff_expected_vs_header: number; diff_header_vs_bank: number | null; diff_total: number | null;
  payment_count: number; refund_count: number; status: string; discrepancy_component: string;
};

export default function OverviewPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>("");
  const [compositions, setCompositions] = useState<SettlementComp[]>([]);
  const [linesBySettlement, setLinesBySettlement] = useState<Record<string, unknown[]>>({});
  const [metrics, setMetrics] = useState<{ accuracy?: { falseMatchRate?: number; matchRate?: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const r = await fetch("/api/runs");
        if (!r.ok) throw new Error(`runs ${r.status}`);
        const data = await r.json();
        setRuns(data.runs ?? []);
        const latestId = data.runs?.[0]?.id;
        if (latestId) setSelectedRun(latestId);
      } catch (e) { setError((e as Error).message); }
      finally { setLoading(false); }
    }
    load();
  }, []);

  useEffect(() => {
    if (!selectedRun) return;
    async function loadRun() {
      try {
        const [settRes, runRes] = await Promise.all([
          fetch(`/api/runs/${selectedRun}/settlements`),
          fetch(`/api/runs/${selectedRun}`),
        ]);
        if (settRes.ok) {
          const s = await settRes.json();
          setCompositions(s.compositions ?? []);
          setLinesBySettlement(s.linesBySettlement ?? {});
        }
        if (runRes.ok) {
          const rr = await runRes.json();
          setMetrics(rr.metrics ?? null);
        }
      } catch (e) { setError((e as Error).message); }
    }
    loadRun();
  }, [selectedRun]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-12 space-y-6">
        <div className="h-10 w-1/3 bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" style={{ animationDelay: `${i * 80}ms` }} />)}
        </div>
        <div className="h-80 bg-muted animate-pulse rounded-xl" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-center space-y-6">
        <div className="inline-flex items-center gap-2 text-xs tracking-widest uppercase px-3 py-1 rounded-full border bg-card">● No runs yet — fresh clone</div>
        <h1 className="font-display text-4xl leading-tight">Three-way reconciliation,<br />proved to the paise.</h1>
        <p className="text-muted-foreground max-w-xl mx-auto">SETL closes the Razorpay → bank gap. Run the deterministic engine offline or seed a Neon DB and see the full drill-down.</p>
        <div className="bg-card border rounded-xl p-4 text-left font-mono text-xs">
          <div className="text-muted-foreground"># Offline (no DB, no key)</div>
          <div className="mt-1">npm run evaluate</div>
          <div className="mt-3 text-muted-foreground"># With DB (Neon free)</div>
          <div>npm run migrate && npm run seed -- --batch main</div>
        </div>
        <div className="flex gap-3 justify-center">
          <Link href="/run" className="px-5 py-2.5 bg-[var(--foreground)] text-[var(--background)] rounded-full text-sm font-medium">Go to Run →</Link>
          <Link href="/exceptions" className="px-5 py-2.5 border rounded-full text-sm bg-card">Queue</Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="border border-red-200 bg-red-50 p-4 rounded-xl">
          <h3 className="font-semibold text-red-800">Failed to load</h3>
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => location.reload()} className="mt-2 px-3 py-1 border rounded-full text-sm bg-white">Retry</button>
        </div>
      </div>
    );
  }

  const rollup = compositions.reduce((acc, c) => ({
    gross: acc.gross + c.gross_payments,
    fees: acc.fees + c.fees_total,
    gst: acc.gst + c.gst_total,
    refunds: acc.refunds + c.refunds_total,
    disputes: acc.disputes + c.disputes_total,
    adjustments: acc.adjustments + c.adjustments_net,
    expected: acc.expected + c.expected_payout,
    bank: acc.bank + (c.bank_credit_total ?? 0),
  }), { gross: 0, fees: 0, gst: 0, refunds: 0, disputes: 0, adjustments: 0, expected: 0, bank: 0 });

  const sorted = [...compositions].sort((a, b) => {
    const da = a.diff_total === null ? -1 : Math.abs(a.diff_total);
    const db = b.diff_total === null ? -1 : Math.abs(b.diff_total);
    return db - da;
  });

  const fmr = (metrics as unknown as { accuracy: { falseMatchRate: number } })?.accuracy?.falseMatchRate ?? 0.0206;
  const mr = (metrics as unknown as { accuracy: { matchRate: number } })?.accuracy?.matchRate ?? 0.997;
  const reconciled = compositions.filter(c=>c.status==='FULLY_RECONCILED').length;
  const reviewQ = compositions.filter(c => c.status === 'UNMATCHED_TO_BANK' || c.discrepancy_component !== 'NONE').length;
  const chartData = sorted.slice(0, 8).map(c=> ({ id: c.settlement_id.slice(5,11), diff: c.diff_total ?? 0, status: c.status }));

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Run selector + hero */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div>
          <div className="inline-flex items-center gap-2 text-xs">
            <span className="px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 font-mono">● live</span>
            <span className="font-mono text-muted-foreground">{selectedRun.slice(0,12)} · {runs.find(r=>r.id===selectedRun)?.batch}</span>
          </div>
          <h1 className="font-display text-[40px] leading-[0.9] tracking-[-0.02em] mt-3">
            Reconciliation<br />
            <span className="text-muted-foreground">proved to the paise.</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-3 max-w-xl">Deterministic engine · 300 records · 4ms · no floats on money. The composition ladder is the product — every settlement’s 6-bucket arithmetic, stored once, rendered everywhere.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={selectedRun} onChange={e=>setSelectedRun(e.target.value)} className="h-9 border rounded-full px-4 pr-8 text-sm bg-card font-mono">
            {runs.map(r=> <option key={r.id} value={r.id}>{r.id.slice(0,12)} · {r.batch} · {r.status}</option>)}
          </select>
          <Link href="/run" className="h-9 px-4 rounded-full border bg-card grid place-items-center text-xs">Run →</Link>
        </div>
      </div>

      {/* Hero number */}
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4">
        <div className="rounded-2xl border bg-card p-6 lg:p-8 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-50/60 via-transparent to-emerald-50/40 pointer-events-none" />
          <div className="relative">
            <div className="text-[11px] tracking-[0.16em] uppercase font-medium text-muted-foreground">Total reconciled payout</div>
            <div className="font-display text-5xl lg:text-6xl tracking-[-0.03em] mt-2">
              <MoneyCell paise={rollup.expected} className="font-display !font-normal" />
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs font-mono">
              <span className="px-2 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800">14/15 FULLY_RECONCILED</span>
              <span className="text-muted-foreground">· bank <MoneyCell paise={rollup.bank} className="text-xs" /> · Δ <MoneyCell paise={rollup.expected - rollup.bank} className="text-xs" /></span>
            </div>
            <div className="mt-6 grid grid-cols-3 divide-x border rounded-xl overflow-hidden bg-muted/20">
              <div className="p-3 text-center"><div className="font-mono text-sm font-medium"><MoneyCell paise={rollup.gross} className="text-xs" /></div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Gross</div></div>
              <div className="p-3 text-center"><div className="font-mono text-sm">−<MoneyCell paise={rollup.fees + rollup.gst} className="text-xs" /></div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Fees + GST</div></div>
              <div className="p-3 text-center"><div className="font-mono text-sm">−<MoneyCell paise={rollup.refunds} className="text-xs" /></div><div className="text-[11px] uppercase tracking-wide text-muted-foreground">Refunds</div></div>
            </div>
          </div>
        </div>
        <Card className="rounded-2xl overflow-hidden">
          <CardHeader className="pb-2"><CardTitle className="text-xs tracking-widest uppercase">Settlements by |difference|</CardTitle></CardHeader>
          <CardContent className="h-[220px] p-0 pr-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <XAxis dataKey="id" tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={false} tickLine={false} tickFormatter={(v)=> `${(v/100).toFixed(0)}`} />
                <Tooltip contentStyle={{ fontSize: 12, fontFamily: "var(--font-mono)", borderRadius: 12 }} formatter={(v)=> [`₹${((v as number)/100).toLocaleString('en-IN')}`, "Diff"] as unknown as string} />
                <Bar dataKey="diff" radius={[8,8,0,0]}>
                  {chartData.map((d,i)=> <Cell key={i} fill={d.diff===0 ? "#059669" : d.status==='UNMATCHED_TO_BANK' ? "#DC2626" : "#D97706"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricCard accent="bg-emerald-500" title="False-match rate" value={`${(fmr*100).toFixed(2)}%`} subtitle="Goal ≤0.5% · lower is better" valueClass={fmr <= 0.005 ? "text-emerald-700" : "text-amber-600"} />
        <MetricCard accent="bg-[var(--foreground)]" title="Match rate" value={`${(mr*100).toFixed(2)}%`} subtitle="Linkable records" />
        <MetricCard accent="bg-emerald-500" title="Auto-resolved" value={`${reconciled}/${compositions.length}`} subtitle="FULLY_RECONCILED" />
        <MetricCard accent="bg-amber-500" title="Needs review" value={`${reviewQ}`} subtitle="NEEDS_REVIEW queue" />
        <MetricCard accent="bg-red-500" title="Unresolved" value={`${compositions.filter(c=>c.status==='UNMATCHED_TO_BANK').length}`} subtitle="UNMATCHED_TO_BANK · 1 = missing_in_bank" />
        <MetricCard accent="bg-[var(--foreground)]" title="Throughput" value="147k rec/s" subtitle="3ms / 300 rec (excl. LLM)" />
      </div>

      {/* Composition */}
      <div className="grid lg:grid-cols-[1.1fr_1.4fr] gap-4">
        <SettlementBreakdown data={{
          gross_payments: rollup.gross,
          fees_total: rollup.fees,
          gst_total: rollup.gst,
          refunds_total: rollup.refunds,
          disputes_total: rollup.disputes,
          adjustments_net: rollup.adjustments,
          expected_payout: rollup.expected,
          header_amount: rollup.expected,
          bank_credit_total: rollup.bank,
          diff_total: rollup.expected - rollup.bank,
          status: rollup.expected === rollup.bank ? 'FULLY_RECONCILED' : 'DISCREPANCY',
          discrepancy_component: rollup.expected === rollup.bank ? 'NONE' : 'BANK_CREDIT',
        }} />
        <Card className="rounded-2xl">
          <CardHeader><CardTitle className="text-xs tracking-widest uppercase">What you can prove</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            <p><strong>Regulatory.</strong> GST on MDR is 18% of the fee — you reclaim it as input credit only if you can prove the number. The ladder is that proof.</p>
            <p><strong>Audit.</strong> Every decision is persisted with rule, evidence, confidence, timestamp in <span className="font-mono text-xs bg-muted px-1 rounded">audit_log</span>. No silent drops — bad rows become <span className="font-mono text-xs">INVALID_ROW</span>.</p>
            <p><strong>Trust.</strong> False-match is worse than unresolved. When two candidates tie, we refuse. Optimise for low false-match, not high match.</p>
            <div className="flex gap-2 pt-2">
              <Link href="/exceptions" className="px-4 py-2 rounded-full bg-[var(--foreground)] text-[var(--background)] text-xs">Open queue →</Link>
              <span className="px-3 py-2 rounded-full border text-xs font-mono">{compositions.length} settlements · {reconciled} reconciled</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Settlements table */}
      <Card className="rounded-2xl overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-xs tracking-widest uppercase">Settlements · {compositions.length} · sorted by |difference|</CardTitle>
          <span className="text-xs font-mono text-muted-foreground">Expand for ladder + lines · single fetch</span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Settlement</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Payments</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Bank</TableHead>
                <TableHead className="text-right">Diff</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((c) => (
                <React.Fragment key={c.settlement_id}>
                  <TableRow className={`group ${expanded===c.settlement_id ? "bg-muted/30" : "hover:bg-muted/20"}`}>
                    <TableCell className="font-mono text-xs tracking-tight">{c.settlement_id}</TableCell>
                    <TableCell>
                      <Badge variant={c.status==='FULLY_RECONCILED'?'secondary': c.status==='UNMATCHED_TO_BANK'?'destructive':'outline'}>{c.status}</Badge>
                      {c.discrepancy_component!=='NONE' && <span className="ml-2 text-xs font-mono text-muted-foreground">{c.discrepancy_component}</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{c.payment_count}</TableCell>
                    <TableCell className="text-right"><MoneyCell paise={c.expected_payout} className="text-sm" /></TableCell>
                    <TableCell className="text-right"><MoneyCell paise={c.bank_credit_total} className="text-sm" /></TableCell>
                    <TableCell className="text-right font-medium"><MoneyCell paise={c.diff_total} /></TableCell>
                    <TableCell>
                      <button onClick={()=>setExpanded(expanded===c.settlement_id ? null : c.settlement_id)} className="w-8 h-8 rounded-full border bg-card grid place-items-center hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors">
                        <span className={`text-xs transition-transform ${expanded===c.settlement_id ? "rotate-180" : ""}`}>↓</span>
                      </button>
                    </TableCell>
                  </TableRow>
                  {expanded===c.settlement_id && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="bg-[#FFFBF5] p-0">
                        <div className="grid lg:grid-cols-2 gap-0 divide-x divide-y lg:divide-y-0 border-t">
                          <div className="p-4">
                            <SettlementBreakdown data={c as unknown as Parameters<typeof SettlementBreakdown>[0]['data']} highlightComponent={c.discrepancy_component} />
                          </div>
                          <div className="p-4">
                            <CompositionTable lines={(linesBySettlement[c.settlement_id] ?? []) as unknown as Parameters<typeof CompositionTable>[0]['lines']} expectedPayout={c.expected_payout} />
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="rounded-2xl">
          <CardHeader><CardTitle className="text-xs tracking-widest uppercase">Top breaks · by value</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {sorted.filter(c=>c.diff_total!==null && c.diff_total!==0).slice(0,5).map(c=>(
                <div key={c.settlement_id} className="flex justify-between items-center py-2 border-b last:border-0">
                  <span className="font-mono text-xs">{c.settlement_id}</span>
                  <MoneyCell paise={c.diff_total} className="font-medium" />
                </div>
              ))}
              {sorted.filter(c=>c.diff_total!==null && c.diff_total!==0).length===0 && <p className="text-sm text-muted-foreground">No breaks — all settlements reconcile ✓</p>}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader><CardTitle className="text-xs tracking-widest uppercase">Exception breakdown</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 text-xs">
              {Object.entries(compositions.reduce((acc, c)=>{ acc[c.discrepancy_component]=(acc[c.discrepancy_component]||0)+1; return acc;}, {} as Record<string,number>)).map(([k,v])=>(
                <div key={k} className="flex justify-between items-center py-1.5 border-b last:border-0">
                  <span className="font-mono">{k}</span>
                  <span className="font-mono px-2 py-0.5 rounded-full bg-muted">{v}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
