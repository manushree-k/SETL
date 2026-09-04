"use client";
import { MoneyCell } from "./MoneyCell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export interface CompositionRow {
  entity_id: string;
  type: string;
  amount?: number; amount_paise?: number;
  fee?: number; fee_paise?: number;
  tax?: number; tax_paise?: number;
  credit?: number; credit_paise?: number;
  debit?: number; debit_paise?: number;
  contribution?: number; contribution_paise?: number;
  contribution_bucket?: string;
  contribution_reason?: string;
  order_id?: string | null;
  method?: string | null;
}

export function CompositionTable({ lines, expectedPayout }: { lines: CompositionRow[]; expectedPayout?: number | null }) {
  const sum = lines.reduce((acc, l) => acc + (l.contribution ?? l.contribution_paise ?? 0), 0);
  const sumOk = expectedPayout === null || expectedPayout === undefined ? true : sum === expectedPayout;

  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Entity</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Gross</TableHead>
            <TableHead>Fee</TableHead>
            <TableHead>GST</TableHead>
            <TableHead>Contribution</TableHead>
            <TableHead>Order</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.length === 0 ? (
            <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No lines in this settlement — this is itself a finding.</TableCell></TableRow>
          ) : lines.map((l) => (
            <TableRow key={l.entity_id}>
              <TableCell className="font-mono text-xs">{l.entity_id}</TableCell>
              <TableCell className="capitalize text-xs">{l.type}</TableCell>
              <TableCell><MoneyCell paise={l.amount ?? l.amount_paise ?? 0} className="text-xs" /></TableCell>
              <TableCell><MoneyCell paise={l.fee ?? l.fee_paise ?? 0} className="text-xs" /></TableCell>
              <TableCell><MoneyCell paise={l.tax ?? l.tax_paise ?? 0} className="text-xs" /></TableCell>
              <TableCell><MoneyCell paise={l.contribution ?? l.contribution_paise ?? 0} className="text-xs font-medium" /></TableCell>
              <TableCell className="font-mono text-xs">{l.order_id ?? "—"}</TableCell>
              <TableCell className="text-xs max-w-[220px] truncate" title={l.contribution_reason ?? ""}>{l.contribution_reason ?? "—"}</TableCell>
            </TableRow>
          ))}
          <TableRow className="bg-muted/50 font-semibold">
            <TableCell colSpan={5} className="text-right">Σ Contribution</TableCell>
            <TableCell><MoneyCell paise={sum} /> {sumOk ? "✓" : "≠ expected"}</TableCell>
            <TableCell colSpan={2} className="text-xs text-muted-foreground">{expectedPayout !== undefined ? `Expected ${expectedPayout !== null ? new Intl.NumberFormat('en-IN').format((expectedPayout)/100) : "—"}` : ""}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
