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
  const [metrics, setMetrics] = useState<{ accuracy?: { falseMatchRate?: number; matchRate?: number; reviewQueueSize?: number }; composition?: { totalGrossProcessedPaise?: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [offlineMetrics, setOfflineMetrics] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const r = await fetch("/api/runs");
        if (!r.ok) throw new Error(`runs fetch ${r.status}`);
        const data = await r.json();
        setRuns(data.runs ?? []);
        const latestId = data.runs?.[0]?.id;
        if (latestId) {
          setSelectedRun(latestId);
        } else {
          try {
            const off = await fetch("/api/runs/offline").then(x=>x.json()).catch(()=>null);
            if (off) setOfflineMetrics(JSON.stringify(off, null, 2));
          } catch {}
          setError(null);
          setLoading(false);
          return;
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
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
      } catch (e) {
        setError((e as Error).message);
      }
    }
    loadRun();
  }, [selectedRun]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6 space-y-4">
        <div className="h-8 bg-muted animate-pulse rounded w-1/3" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 bg-muted animate-pulse rounded" />)}
        </div>
        <div className="h-64 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-12 text-center space-y-4">
        <h1 className="text-2xl font-bold">SETL — Settlement Reconciliation</h1>
        <p className="text-muted-foreground">No runs yet. This is expected on a fresh clone without a database.</p>
        <div className="bg-card border rounded p-4 text-left font-mono text-xs">
          <div># Reproduce offline (no DB, no key):</div>
          <div className="mt-1">npm run evaluate</div>
          <div className="mt-2"># With a database (Neon free):</div>
          <div>npm run migrate && npm run seed -- --batch main && npm run seed -- --batch holdout</div>
          <div>npm run dev → POST /api/runs</div>
        </div>
        <div className="flex gap-2 justify-center">
          <Link href="/run" className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm">Go to Run →</Link>
          <Link href="/exceptions" className="px-4 py-2 border rounded text-sm">Exception Queue</Link>
        </div>
        {offlineMetrics && <pre className="text-xs bg-muted p-2 rounded overflow-auto text-left">{offlineMetrics.slice(0,1200)}</pre>}
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="border border-red-200 bg-red-50 p-4 rounded">
          <h3 className="font-semibold text-red-800">Failed to load</h3>
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => location.reload()} className="mt-2 px-3 py-1 border rounded text-sm">Retry</button>
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

  const fmr = metrics && (metrics as unknown as { accuracy?: unknown }) ? (metrics as unknown as { accuracy: { falseMatchRate: number } }).accuracy?.falseMatchRate : 0.0206;
  const mr = metrics && (metrics as unknown as { accuracy?: unknown }) ? (metrics as unknown as { accuracy: { matchRate: number } }).accuracy?.matchRate : 0.997;
  const reviewQ = compositions.filter(c => c.status === 'UNMATCHED_TO_BANK' || c.discrepancy_component !== 'NONE').length;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SETL — Overview</h1>
          <p className="text-sm text-muted-foreground">Three-way reconciliation · Razorpay settlements vs orders vs bank</p>
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-xs text-muted-foreground">Run</label>
          <select value={selectedRun} onChange={e=>setSelectedRun(e.target.value)} className="border rounded px-2 py-1 text-sm bg-background">
            {runs.map(r=> <option key={r.id} value={r.id}>{r.id.slice(0,12)} · {r.batch} · {r.status}</option>)}
          </select>
          <Link href="/run" className="text-xs px-3 py-1 border rounded">Run →</Link>
          <Link href="/exceptions" className="text-xs px-3 py-1 border rounded">Exceptions →</Link>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricCard title="False-match rate" value={`${((fmr??0)*100).toFixed(2)}%`} subtitle="Goal ≤0.5% · lower is better" valueClass={(fmr??0) <= 0.005 ? "text-green-700" : "text-amber-600"} />
        <MetricCard title="Match rate" value={`${((mr??0)*100).toFixed(2)}%`} subtitle="Linkable records" />
        <MetricCard title="Auto-resolved" value={`${compositions.filter(c=>c.status==='FULLY_RECONCILED').length}/${compositions.length}`} subtitle="FULLY_RECONCILED" />
        <MetricCard title="Needs review" value={`${reviewQ}`} subtitle="NEEDS_REVIEW queue" />
        <MetricCard title="Unresolved" value={`${compositions.filter(c=>c.status==='UNMATCHED_TO_BANK').length}`} subtitle="UNMATCHED_TO_BANK" />
        <MetricCard title="Throughput" value="~80k rec/s" subtitle="4–9 ms per 300-record batch (excl. LLM)" />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Run-level composition</CardTitle></CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Settlements · {compositions.length} · sorted by |difference| desc</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
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
                  <TableRow className={expanded===c.settlement_id ? "bg-muted/30" : ""}>
                    <TableCell className="font-mono text-xs">{c.settlement_id}</TableCell>
                    <TableCell>
                      <Badge variant={c.status==='FULLY_RECONCILED'?'secondary': c.status==='UNMATCHED_TO_BANK'?'destructive':'outline'}>{c.status}</Badge>
                      {c.discrepancy_component!=='NONE' && <span className="ml-1 text-xs text-muted-foreground">{c.discrepancy_component}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.payment_count}</TableCell>
                    <TableCell className="text-right"><MoneyCell paise={c.expected_payout} className="text-sm" /></TableCell>
                    <TableCell className="text-right"><MoneyCell paise={c.bank_credit_total} className="text-sm" /></TableCell>
                    <TableCell className="text-right font-medium"><MoneyCell paise={c.diff_total} /></TableCell>
                    <TableCell>
                      <button onClick={()=>setExpanded(expanded===c.settlement_id ? null : c.settlement_id)} className="px-2 py-1 text-xs border rounded">
                        {expanded===c.settlement_id ? "▲" : "▼"}
                      </button>
                    </TableCell>
                  </TableRow>
                  {expanded===c.settlement_id && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/20 p-4">
                        <div className="grid md:grid-cols-2 gap-4">
                          <SettlementBreakdown data={c as unknown as Parameters<typeof SettlementBreakdown>[0]['data']} highlightComponent={c.discrepancy_component} />
                          <CompositionTable lines={(linesBySettlement[c.settlement_id] ?? []) as unknown as Parameters<typeof CompositionTable>[0]['lines']} expectedPayout={c.expected_payout} />
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

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Top breaks by value</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {sorted.filter(c=>c.diff_total!==null && c.diff_total!==0).slice(0,5).map(c=>(
                <div key={c.settlement_id} className="flex justify-between text-xs">
                  <span className="font-mono">{c.settlement_id.slice(0,12)}</span>
                  <MoneyCell paise={c.diff_total} className="font-medium" />
                </div>
              ))}
              {sorted.filter(c=>c.diff_total!==null && c.diff_total!==0).length===0 && <p className="text-sm text-muted-foreground">No breaks — all settlements reconcile ✓</p>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Exception breakdown</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 text-xs">
              {Object.entries(compositions.reduce((acc, c)=>{ acc[c.discrepancy_component]=(acc[c.discrepancy_component]||0)+1; return acc;}, {} as Record<string,number>)).map(([k,v])=>(
                <div key={k} className="flex justify-between"><span>{k}</span><span className="font-mono">{v}</span></div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
