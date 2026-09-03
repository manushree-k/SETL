"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/", label: "Overview" },
  { href: "/run", label: "Run" },
  { href: "/exceptions", label: "Exceptions" },
];

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-40 backdrop-blur-xl bg-[var(--background)]/80 border-b border-[var(--border)]">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-7 h-7 rounded bg-[var(--foreground)] text-[var(--background)] grid place-items-center font-mono text-xs font-bold">◈</div>
            <span className="font-display text-xl tracking-tight">SETL</span>
            <span className="hidden sm:inline text-xs tracking-widest uppercase text-muted-foreground border-l pl-3 ml-1">Reconciliation</span>
          </Link>
          <div className="hidden md:flex items-center gap-1">
            {links.map(l => {
              const active = pathname === l.href || (l.href !== "/" && pathname.startsWith(l.href));
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${active ? "bg-[var(--foreground)] text-[var(--background)]" : "hover:bg-muted"}`}
                >
                  {l.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-mono text-muted-foreground">300 rec · 4ms</span>
          </div>
          <a href="https://github.com/manushree-k/SETL" target="_blank" rel="noopener noreferrer" className="hidden sm:grid w-8 h-8 rounded-full border place-items-center hover:bg-muted">
            <span className="text-xs">↗</span>
          </a>
          {/* Mobile menu button */}
          <button
            onClick={() => setOpen(!open)}
            className="md:hidden w-9 h-9 rounded-full border grid place-items-center bg-card"
            aria-label="Toggle menu"
          >
            <span className="text-sm">{open ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="md:hidden border-t bg-card">
          <div className="px-6 py-3 flex flex-col gap-2">
            {links.map(l => {
              const active = pathname === l.href || (l.href !== "/" && pathname.startsWith(l.href));
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={`px-4 py-2.5 rounded-xl text-sm font-medium ${active ? "bg-[var(--foreground)] text-[var(--background)]" : "bg-muted"}`}
                >
                  {l.label}
                </Link>
              );
            })}
            <a href="https://github.com/manushree-k/SETL" target="_blank" rel="noopener noreferrer" className="px-4 py-2.5 rounded-xl border text-sm text-center">GitHub ↗</a>
          </div>
        </div>
      )}
    </nav>
  );
}
