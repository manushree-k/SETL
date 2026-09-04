"use client";

export function EvidenceTable({ evidence }: { evidence: Record<string, unknown> }) {
  if (!evidence || Object.keys(evidence).length === 0) return <p className="text-sm text-muted-foreground">No evidence.</p>;
  return (
    <div className="rounded border overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {Object.entries(evidence).map(([k, v]) => (
            <tr key={k} className="border-b last:border-0">
              <td className="p-2 font-mono bg-muted/30 w-1/3 align-top">{k}</td>
              <td className="p-2 font-mono whitespace-pre-wrap break-all">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
