"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ExceptionBadge } from "@/components/ExceptionBadge";
import { ConfidenceBar } from "@/components/ConfidenceBar";
import { MoneyCell } from "@/components/MoneyCell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Exc = {
  id: string; run_id: string; record_source: string; record_id: string;
  class: string; decision: string; confidence: number; amount_impact: number;
  deterministic_reason: string; next_action: string | null;
};

const ALL_CLASSES = [
  'MATCHED_EXACT','FEE_DEDUCTION','GST_ON_FEE','TDS_194O','TIMING_DIFFERENCE',
  'PARTIAL_SETTLEMENT','SPLIT_PAYOUT','REFUND_NETTED','DISPUTE_HOLD','DUPLICATE_CREDIT',
  'MISSING_IN_BANK','MISSING_IN_LEDGER','NOT_SETTLED','AMOUNT_MISMATCH','FEE_OVERCHARGE',
  'ROUNDING_RESIDUAL','UNRESOLVED','INVALID_ROW'
];

export default function ExceptionsPage() {
  const [exceptions, setExceptions] = useState<Exc[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [runId, setRunId] = useState<string>("");
  const [runs, setRuns] = useState<{id:string; batch:string}[]>([]);
  const [decisionFilter, setDecisionFilter] = useState<string[]>(["UNRESOLVED","NEEDS_REVIEW"]);
  const [classFilter, setClassFilter] = useState<string[]>([]);
  const [minAmount, setMinAmount] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/runs").then(r=>r.json()).then(d=> {
      setRuns(d.runs ?? []);
      if (d.runs?.[0]) setRunId(d.runs[0].id);
    }).catch(()=>{});
  }, []);

  async function load(p = page) {
    setLoading(true);
    const params = new URLSearchParams();
    if (runId) params.set("runId", runId);
    if (decisionFilter.length) params.set("decision", decisionFilter.join(","));
    if (classFilter.length) params.set("class", classFilter.join(","));
    if (minAmount) params.set("minAmount", String(Math.round(parseFloat(minAmount||"0")*100)));
    if (q) params.set("q", q);
    params.set("page", String(p));
    params.set("limit", "25");
    try {
      const res = await fetch(`/api/exceptions?${params.toString()}`);
      const data = await res.json();
      setExceptions(data.exceptions ?? []);
      setTotal(data.total ?? 0);
    } catch {}
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=> { if (runId) load(1); }, [runId]);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Exception Queue</h1>
          <p className="text-sm text-muted-foreground">Default: UNRESOLVED + NEEDS_REVIEW · sorted by ₹ impact desc · paginated 25</p>
        </div>
        <div className="flex gap-2">
          <Link href="/" className="px-3 py-1 border rounded text-sm">Overview</Link>
          <Link href="/run" className="px-3 py-1 border rounded text-sm">Run</Link>
        </div>
      </header>

      <Card>
        <CardHeader><CardTitle className="text-sm">Filters</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <select value={runId} onChange={e=>setRunId(e.target.value)} className="border rounded px-2 py-1 text-sm">
              {runs.map(r=> <option key={r.id} value={r.id}>{r.id.slice(0,12)} · {r.batch}</option>)}
            </select>
            <input placeholder="Search record ID..." value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter' && load(1)} className="border rounded px-2 py-1 text-sm w-48" />
            <input placeholder="Min ₹ amount" value={minAmount} onChange={e=>setMinAmount(e.target.value)} className="border rounded px-2 py-1 text-sm w-32" />
            <button onClick={()=>load(1)} className="px-3 py-1 bg-primary text-primary-foreground rounded text-sm">Apply</button>
            <button onClick={()=>{ setDecisionFilter(["UNRESOLVED","NEEDS_REVIEW"]); setClassFilter([]); setMinAmount(""); setQ(""); }} className="px-3 py-1 border rounded text-sm">Clear</button>
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground py-1">Decision:</span>
            {["AUTO_RESOLVED","NEEDS_REVIEW","UNRESOLVED"].map(d=> (
              <label key={d} className="flex items-center gap-1 text-xs border rounded px-2 py-1 cursor-pointer">
                <input type="checkbox" checked={decisionFilter.includes(d)} onChange={e=> setDecisionFilter(e.target.checked ? [...decisionFilter,d] : decisionFilter.filter(x=>x!==d))} /> {d}
              </label>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground py-1">Class:</span>
            {ALL_CLASSES.slice(0,8).map(c=> (
              <label key={c} className="flex items-center gap-1 text-xs border rounded px-2 py-1 cursor-pointer">
                <input type="checkbox" checked={classFilter.includes(c)} onChange={e=> setClassFilter(e.target.checked ? [...classFilter,c] : classFilter.filter(x=>x!==c))} /> {c}
              </label>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">Total: {total} · page {page} · {Math.ceil(total/25)} pages</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Class</TableHead>
                <TableHead className="text-right">Impact</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Next action</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8">Loading…</TableCell></TableRow>
              ) : exceptions.length===0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No exceptions. Clear filters or run a reconciliation.</TableCell></TableRow>
              ) : exceptions.map(e=> (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.record_id}</TableCell>
                  <TableCell className="text-xs capitalize">{e.record_source}</TableCell>
                  <TableCell><ExceptionBadge klass={e.class} /></TableCell>
                  <TableCell className="text-right"><MoneyCell paise={e.amount_impact} className="text-xs" /></TableCell>
                  <TableCell><div className="flex items-center gap-2"><ConfidenceBar value={e.confidence} /><span className="text-xs font-mono">{Math.round(e.confidence*100)}%</span></div></TableCell>
                  <TableCell><span className={`text-xs px-2 py-0.5 rounded-full border ${e.decision==='AUTO_RESOLVED'?'bg-green-50 border-green-200': e.decision==='NEEDS_REVIEW'?'bg-amber-50 border-amber-200':'bg-zinc-900 text-white'}`}>{e.decision}</span></TableCell>
                  <TableCell className="text-xs max-w-[180px] truncate" title={e.next_action ?? ""}>{e.next_action ?? "—"}</TableCell>
                  <TableCell><Link href={`/exceptions/${e.id}`} className="text-xs px-2 py-1 border rounded">View →</Link></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <button disabled={page<=1} onClick={()=>{ const p=page-1; setPage(p); load(p); }} className="px-3 py-1 border rounded text-sm disabled:opacity-50">← Prev</button>
        <span className="text-xs">Page {page} of {Math.max(1, Math.ceil(total/25))}</span>
        <button disabled={page>=Math.ceil(total/25)} onClick={()=>{ const p=page+1; setPage(p); load(p); }} className="px-3 py-1 border rounded text-sm disabled:opacity-50">Next →</button>
      </div>
    </div>
  );
}
