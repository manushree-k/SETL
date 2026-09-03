import type { Metadata } from "next";
import { Instrument_Serif, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/Navbar";

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
          <Navbar />
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
