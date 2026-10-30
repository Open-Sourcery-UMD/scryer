import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scryer | Know what your records actually show",
  description:
    "Trace financial aid through school charges, refunds, and bank observations with reviewed evidence and exact explanations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="site-frame">
          <header className="site-header">
            <Link href="/" className="brand" aria-label="Scryer home">
              <span className="brand-mark" aria-hidden="true">✦</span>
              <span>Scryer</span>
            </Link>
            <nav className="site-nav" aria-label="Main navigation">
              <Link href="/#how-it-works">How it works</Link>
              <Link href="/demo">Synthetic case</Link>
              <a href="https://github.com/Open-Sourcery-UMD/scryer" target="_blank" rel="noreferrer">
                Open source <span aria-hidden="true">↗</span>
              </a>
            </nav>
          </header>
          <main id="main-content" tabIndex={-1}>{children}</main>
          <footer className="site-footer">
            <div className="brand"><span className="brand-mark" aria-hidden="true">✦</span><span>Scryer</span></div>
            <p>Built by Open Sourcery at the University of Maryland.</p>
            <p>Explain the evidence. Name what remains unknown.</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
