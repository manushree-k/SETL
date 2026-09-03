/* eslint-disable @next/next/no-html-link-for-pages */
import type { Metadata } from "next";
import { Instrument_Serif, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
});

const sans = Instrument_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SETL — Settlement Reconciliation",
  description: "Three-way reconciliation for Razorpay settlements · AI Finance Controller",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}>
        <div className="min-h-screen bg-[var(--background)]">
          <nav className="sticky top-0 z-40 backdrop-blur-xl bg-[var(--background)]/80 border-b border-[var(--border)]">
            <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
              <div className="flex items-center gap-8">
                <a href="/" className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded bg-[var(--foreground)] text-[var(--background)] grid place-items-center font-mono text-xs font-bold">◈</div>
                  <span className="font-display text-xl tracking-tight">SETL</span>
                  <span className="hidden sm:inline text-xs tracking-widest uppercase text-muted-foreground border-l pl-3 ml-1">Reconciliation</span>
                </a>
                <div className="hidden md:flex items-center gap-1 text-sm">
                  {/* eslint-disable @next/next/no-html-link-for-pages */}
                  <a href="/" className="px-3 py-1.5 rounded-full bg-[var(--foreground)] text-[var(--background)] text-xs font-medium">Overview</a>
                  <a href="/run" className="px-3 py-1.5 rounded-full hover:bg-muted text-xs">Run</a>
                  <a href="/exceptions" className="px-3 py-1.5 rounded-full hover:bg-muted text-xs">Exceptions</a>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="hidden sm:flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="font-mono text-muted-foreground">300 records · 4ms</span>
                </div>
                <a href="https://github.com/manushree-k/SETL" target="_blank" className="w-8 h-8 rounded-full border grid place-items-center hover:bg-muted">
                  <span className="text-xs">↗</span>
                </a>
              </div>
            </div>
          </nav>
          {children}
          <footer className="border-t mt-12">
            <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="font-mono">© 2026 SETL · Razorpay Buildathon Track 04 · Deterministic engine · No floats on money</span>
              <span className="font-mono">Neon free · Vercel Hobby · `npm run evaluate` reproduces</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
