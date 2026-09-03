"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { SettlementBreakdown } from "@/components/SettlementBreakdown";
import { CompositionTable } from "@/components/CompositionTable";
import { EvidenceTable } from "@/components/EvidenceTable";
import { ExceptionBadge } from "@/components/ExceptionBadge";
import { MoneyCell } from "@/components/MoneyCell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function InvestigationPage() {
  const params = useParams() as { id: string };
  const id = params.id;
  const [data, setData] = useState<{ exception: { id:string; class:string; decision:string; confidence:number; amount_impact:number; deterministic_reason:string; ai_explanation:string|null; ai_status:string; next_action:string|null; evidence:Record<string,unknown> }; composition: unknown | null; lines: unknown[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{explanation:string; status:string}|null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/exceptions/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        setData(j);
      } catch (e) { setError((e as Error).message); }
      finally { setLoading(false); }
    }
    if (id) load();
  }, [id]);

  async function explain() {
    setAiLoading(true);
    try {
      const res = await fetch(`/api/exceptions/${id}/explain`, { method: "POST" });
      const j = await res.json();
      setAiResult({ explanation: j.ai_explanation ?? j.error, status: j.ai_status ?? "error" });
      // reload to reflect persisted value
      const re = await fetch(`/api/exceptions/${id}`);
      if (re.ok) setData(await re.json());
    } catch (e) { setAiResult({ explanation: (e as Error).message, status: "error" }); }
    finally { setAiLoading(false); }
  }

  if (loading) return <div className="max-w-4xl mx-auto p-6">Loading…</div>;
  if (error || !data) return <div className="max-w-4xl mx-auto p-6 border border-red-200 bg-red-50 rounded p-4">{error ?? "Not found"}</div>;

  const exc = data.exception;
  const comp = data.composition as { status?: string; discrepancy_component?: string; expected_payout?: number; gross_payments?: number } | null;
  const lines = (data.lines ?? []) as Parameters<typeof CompositionTable>[0]['lines'];
  const evidence = (exc.evidence ?? {}) as Record<string, unknown>;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <Link href="/exceptions" className="px-3 py-1 border rounded text-sm">← Queue</Link>
        <Link href="/" className="px-3 py-1 border rounded text-sm">Overview</Link>
        <h1 className="text-xl font-bold">Investigation — {exc.id.slice(0,12)}</h1>
      </header>

      {/* 1. What happened */}
      <Card>
        <CardHeader><CardTitle className="text-sm">1 · What happened</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <ExceptionBadge klass={exc.class} />
            <span className="text-sm">Impact</span> <MoneyCell paise={exc.amount_impact} className="font-semibold" />
            <span className={`text-xs px-2 py-0.5 rounded-full border ${exc.decision==='AUTO_RESOLVED'?'bg-green-50': exc.decision==='NEEDS_REVIEW'?'bg-amber-50':'bg-zinc-900 text-white'}`}>{exc.decision}</span>
            <span className="text-xs font-mono">{Math.round(exc.confidence*100)}% confidence</span>
          </div>
          <p className="text-sm bg-muted/50 p-3 rounded">{exc.deterministic_reason}</p>
        </CardContent>
      </Card>

      {/* 2. Settlement breakdown ladder with highlighted failing bucket */}
      {comp ? (
        <Card>
          <CardHeader><CardTitle className="text-sm">2 · Settlement breakdown {comp.discrepancy_component && comp.discrepancy_component!=='NONE' && <span className="font-normal text-muted-foreground">(failing bucket highlighted)</span>}</CardTitle></CardHeader>
          <CardContent>
            <SettlementBreakdown data={comp as unknown as Parameters<typeof SettlementBreakdown>[0]['data']} highlightComponent={comp.discrepancy_component} />
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">No settlement composition — this exception is not attached to a settlement.</CardContent></Card>
      )}

      {/* 3. Drill-down lines */}
      {comp && (
        <Card>
          <CardHeader><CardTitle className="text-sm">3 · Drill-down — this settlement&apos;s own lines</CardTitle></CardHeader>
          <CardContent>
            <CompositionTable lines={lines} expectedPayout={(comp as unknown as { expected_payout:number }).expected_payout} />
            <p className="text-xs text-muted-foreground mt-2">One level only: settlement → its lines. Contribution column sums to expected payout ✓</p>
          </CardContent>
        </Card>
      )}

      {/* 4. Evidence */}
      <Card>
        <CardHeader><CardTitle className="text-sm">4 · Evidence — records side by side</CardTitle></CardHeader>
        <CardContent>
          <EvidenceTable evidence={evidence} />
          <button onClick={()=> navigator.clipboard.writeText(JSON.stringify(evidence,null,2))} className="mt-2 px-3 py-1 border rounded text-xs">Copy evidence JSON</button>
        </CardContent>
      </Card>

      {/* 5. How we decided */}
      <Card>
        <CardHeader><CardTitle className="text-sm">5 · How we decided</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>Class: <ExceptionBadge klass={exc.class} /></div>
          <div>Confidence: {exc.confidence} ({Math.round(exc.confidence*100)}%)</div>
          <div>Decision: {exc.decision}</div>
          <div className="text-xs text-muted-foreground">Evidence keys: {Object.keys(evidence).join(", ") || "—"}</div>
        </CardContent>
      </Card>

      {/* 6. AI explanation */}
      <Card>
        <CardHeader><CardTitle className="text-sm">6 · AI explanation {exc.ai_status && <span className={`ml-2 text-xs px-2 py-0.5 rounded-full border ${exc.ai_status==='ok'?'bg-green-50 border-green-200': exc.ai_status==='rejected_by_guard'?'bg-red-50 border-red-200': 'bg-muted'}`}>{exc.ai_status}</span>}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {aiLoading ? <div className="h-12 bg-muted animate-pulse rounded" /> : (
            <>
              <p className="text-sm p-3 rounded bg-card border min-h-[48px]">{aiResult?.explanation ?? exc.ai_explanation ?? "No AI explanation yet. Click below to generate."}</p>
              {aiResult?.status==='rejected_by_guard' && <p className="text-xs text-red-700">Number guard rejected — hallucinated number detected. Deterministic reason above is unaffected.</p>}
              {exc.ai_status==='error' && <p className="text-xs text-muted-foreground">Explanation unavailable. The deterministic reason above is unaffected.</p>}
            </>
          )}
          <button onClick={explain} disabled={aiLoading} className="px-3 py-1 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50">
            {aiLoading ? "Generating…" : "Explain with AI"}
          </button>
        </CardContent>
      </Card>

      {/* 7. Competing candidates */}
      <Card>
        <CardHeader><CardTitle className="text-sm">7 · Competing candidates (if ambiguous)</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {evidence.ambiguousCandidate || evidence.ambiguousMatch || evidence.competingCandidates ? (
            <EvidenceTable evidence={evidence as Record<string,unknown>} />
          ) : <p className="text-muted-foreground">No competing candidates — single unique match or no link attempted.</p>}
        </CardContent>
      </Card>

      {/* 8. Why unresolved */}
      {exc.decision==='UNRESOLVED' && (
        <Card>
          <CardHeader><CardTitle className="text-sm">8 · Why unresolved</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <p>The engine refused to guess. A false match silently posts wrong numbers; an unresolved record stays in the queue for a human. This is the correct behaviour for ambiguous or corrupted data.</p>
          </CardContent>
        </Card>
      )}

      {/* 9. Next action */}
      <Card>
        <CardHeader><CardTitle className="text-sm">9 · Next action</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <p className="font-medium">{exc.next_action ?? "Manual investigation"}</p>
          <p className="text-xs text-muted-foreground mt-1">SLA per taxonomy — see SETL_BLUEPRINT.md §11</p>
        </CardContent>
      </Card>
    </div>
  );
}
