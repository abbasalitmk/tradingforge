export const dynamic = 'force-dynamic';

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ color: 'var(--muted)' }}>{label}</div>
      <div>
        <div className="mono">{value}</div>
        {note && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>{note}</div>}
      </div>
    </div>
  );
}

export default function Page() {
  const mode = process.env.TF_MODE ?? 'PAPER';
  const configured = Boolean(process.env.TF_WEBHOOK_SECRET && process.env.TF_ENGINE_URL);

  return (
    <>
      <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>Control plane</h1>
      <p style={{ color: 'var(--muted)', margin: '0 0 26px' }}>
        Phase 0 — webhook receivers and OAuth callback are live. The trading engine runs
        separately on a static-IP host; this deployment holds no Upstox credentials and places
        no orders.
      </p>

      <section style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '4px 16px 12px' }}>
        <Row label="Mode" value={mode} note="PAPER blocks every outbound order path." />
        <Row
          label="Engine link"
          value={configured ? 'configured' : 'not configured'}
          note="Cloudflare Tunnel to the engine. Webhook hints are relayed, never trusted."
        />
        <Row
          label="Order webhook"
          value="POST /api/webhooks/upstox/order/{secret}"
          note="Unauthenticated by Upstox — the path secret is the only guard. Treated as a hint that triggers an authenticated re-poll."
        />
        <Row
          label="Token notifier"
          value="POST /api/webhooks/upstox/token/{secret}"
          note="Receives the daily access token. Forwarded to the engine and dropped; never logged or stored here."
        />
        <Row label="OAuth callback" value="GET /api/auth/callback" note="Relays the code; the engine performs the exchange." />
        <Row label="Health" value="GET /api/health" />
      </section>

      <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 22 }}>
        Next: engine process (Upstox client, rate limiter, broker port), then the data plane.
        See <code>docs/00-PLAN.md</code>.
      </p>
    </>
  );
}
