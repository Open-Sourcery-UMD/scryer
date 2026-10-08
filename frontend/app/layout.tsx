import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scryer | Wealth Intelligence",
  description: "Privacy-first financial aggregator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-background text-foreground">
        <div className="flex min-h-screen">
          {/* Sidebar */}
          <aside className="w-64 border-r bg-card p-6 flex flex-col gap-8">
            <div className="font-bold text-xl tracking-tight text-primary">🔮 Scryer</div>
            <nav className="flex flex-col gap-2">
              {["Dashboard", "Transactions", "Accounts", "Settings"].map((item) => (
                <a
                  key={item}
                  href="#"
                  className="px-3 py-2 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors text-sm font-medium"
                >
                  {item}
                </a>
              ))}
            </nav>
          </aside>

          {/* Main Content Area */}
          <main className="flex-1 p-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
