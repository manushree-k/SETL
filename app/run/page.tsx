"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function RunPage() {
  const [batch, setBatch] = useState<"main"|"holdout">("main");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{orders:number; settlements:number; lines:number; bank:number} | null>(null);

  useEffect(() => {
    setSummary(batch==="main" ? { orders: 180, settlements: 15, lines: 260, bank: 20 } : { orders: 120, settlements: 15, lines: 220, bank: 18 });
  }, [batch]);

  async function run() {
    setRunning(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/runs", { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify({ batch }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally { setRunning(false); }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Run Reconciliation</h1>
        <p className="text-sm text-muted-foreground">Batch selector · live stage timings</p>
      </header>

      <Card>
        <CardHeader><CardTitle className="text-sm">Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={batch==='main'} onChange={()=>setBatch('main')} /> main (kiranakart)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={batch==='holdout'} onChange={()=>setBatch('holdout')} /> holdout (bombayweave)
            </label>
          </div>
          {summary && (
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div className="border rounded p-2 text-center"><div className="font-mono font-bold">{summary.orders}</div><div className="text-muted-foreground">orders</div></div>
              <div className="border rounded p-2 text-center"><div className="font-mono font-bold">{summary.settlements}</div><div className="text-muted-foreground">settlements</div></div>
              <div className="border rounded p-2 text-center"><div className="font-mono font-bold">{summary.lines}</div><div className="text-muted-foreground">lines</div></div>
              <div className="border rounded p-2 text-center"><div className="font-mono font-bold">{summary.bank}</div><div className="text-muted-foreground">bank lines</div></div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled checked={false} readOnly /> LLM enabled (narration parser) <span className="text-xs text-muted-foreground">— engine deterministic either way</span>
          </label>
          <button onClick={run} disabled={running} className="w-full py-2 bg-primary text-primary-foreground rounded font-medium disabled:opacity-50">
            {running ? "Reconciling…" : `Reconcile 300 records`}
          </button>
          <p className="text-xs text-muted-foreground">Also works offline: <code className="bg-muted px-1 rounded">npm run evaluate</code> (no DB, no key)</p>
        </CardContent>
      </Card>

      {error && <div className="border border-red-200 bg-red-50 p-3 rounded text-sm text-red-800">{error}</div>}
      {result ? (
        <Card>
          <CardHeader><CardTitle className="text-sm">Result</CardTitle></CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted p-3 rounded overflow-auto whitespace-pre-wrap">{JSON.stringify(result,null,2)}</pre>
            <div className="mt-3 flex gap-2">
              <Link href="/" className="px-3 py-1 border rounded text-sm">Overview →</Link>
              <Link href="/exceptions" className="px-3 py-1 border rounded text-sm">Exceptions →</Link>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
