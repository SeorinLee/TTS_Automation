import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "TikTok Creator GMV",
  description: "TikTok Shop Affiliate creator GMV lookup",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">GMV Finder</Link>
          <nav aria-label="주요 메뉴">
            <Link href="/">새 작업</Link>
            <Link href="/results">조회 결과</Link>
            <Link href="/settings">TikTok 로그인</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
        <Script src="/app-shell.js?v=8" strategy="afterInteractive" />
        <Script
          src="/browser-market-selector.js?v=7"
          strategy="afterInteractive"
          data-browser-market-selector="true"
        />
      </body>
    </html>
  );
}
