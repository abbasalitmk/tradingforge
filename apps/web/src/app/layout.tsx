import type { Metadata } from 'next';
import './globals.css';
import ThemeToggle from './components/ThemeToggle';
import TradingModeToggle from './components/TradingModeToggle';

export const metadata: Metadata = {
  title: 'TradeForger | Autonomous Trading Control Plane',
  description: 'AI-driven autonomous trading system for NSE equities and F&O with real-time Upstox execution',
  robots: { index: false, follow: false },
};

const MODE = process.env.TF_MODE ?? 'PAPER';
const LIVE = MODE === 'LIVE';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        {/* Modern Web Guidance: FOUC Prevention Script */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var stored = localStorage.getItem('tf-theme');
                  var meta = document.querySelector('meta[name="color-scheme"]');
                  if (stored === 'dark' || stored === 'light') {
                    document.documentElement.dataset.theme = stored;
                    if (meta) meta.content = stored;
                  } else {
                    document.documentElement.dataset.theme = 'system';
                    if (meta) meta.content = 'light dark';
                  }
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body>
        {/* Floating Glassmorphic Top Navigation Header */}
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 24px',
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderBottom: '1px solid var(--line)',
            boxShadow: 'var(--card-shadow)',
          }}
        >
          {/* Brand Identity & Engine Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'linear-gradient(135deg, var(--accent) 0%, #1e40af 100%)',
                color: '#ffffff',
                boxShadow: '0 2px 6px rgba(37,99,235,0.3)',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.02em', color: 'var(--fg)' }}>
                  TradeForger
                </span>
                <TradingModeToggle compact />
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                <span>Autonomous Trading Desk</span>
                <span>•</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    className="pulse-dot"
                    style={{ background: 'var(--ok)', width: 6, height: 6 }}
                  />
                  <span>NSE Live Connect</span>
                </span>
              </div>
            </div>
          </div>

          {/* Controls, Telemetry & Theme Switcher */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                display: 'none',
              }}
              className="mono"
            >
              Read-only web control plane · Orders routed via TradeForger Core
            </span>

            <div style={{ height: 20, width: 1, background: 'var(--line)' }} />

            {/* Theme Toggle (Light / Dark / System) */}
            <ThemeToggle />
          </div>
        </header>

        {/* Main Content Area */}
        <main
          style={{
            maxWidth: 1440,
            margin: '0 auto',
            padding: '24px 24px 40px',
            minHeight: '100vh',
          }}
        >
          {children}
        </main>
      </body>
    </html>
  );
}
