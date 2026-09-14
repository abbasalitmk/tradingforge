import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness for the control plane only. Says nothing about the engine or
 *  about whether trading is safe — see the engine's own /preflight for that. */
export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'tradeforger-web',
    role: 'control-plane',
    mode: process.env.TF_MODE ?? 'PAPER',
    ts: new Date().toISOString(),
  });
}
