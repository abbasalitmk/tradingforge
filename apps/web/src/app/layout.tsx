import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TradeForger',
  description: 'Autonomous equity trading control plane',
  robots: { index: false, follow: false },
};

const MODE = process.env.TF_MODE ?? 'PAPER';
const LIVE = MODE === 'LIVE';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
            borderBottom: '1px solid var(--line)', background: 'var(--panel)',
          }}
        >
          <strong style={{ letterSpacing: '-0.01em' }}>TradeForger</strong>
          <span
            className="mono"
            style={{
              padding: '2px 8px', borderRadius: 4, fontWeight: 600,
              background: LIVE ? 'var(--danger)' : 'var(--line)',
              color: LIVE ? '#fff' : 'var(--muted)',
            }}
          >
            {MODE}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>
            control plane · no credentials held here
          </span>
        </header>

        <main style={{ maxWidth: 920, margin: '0 auto', padding: '28px 20px 64px' }}>
          {children}
        </main>

        {/* Non-dismissible, per the plan's §4.8 regulatory posture. */}
        <footer
          style={{
            position: 'sticky', bottom: 0, padding: '10px 20px',
            borderTop: '1px solid var(--line)', background: 'var(--panel)',
            color: 'var(--muted)', fontSize: 11.5,
          }}
        >
          Signals are research support, not investment advice. Backtested results do not predict
          future performance. You are solely responsible for every order this system places.
          Verify all account data directly on Upstox.
        </footer>
      </body>
    </html>
  );
}
