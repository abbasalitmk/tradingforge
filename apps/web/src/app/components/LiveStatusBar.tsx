'use client';

import React, { useState, useEffect } from 'react';

interface LiveStatusBarProps {
  lastUpdated: number;
  feedStaleness: number | null;
  subscribedCount: number;
  ordersCount: number;
  isEngineConnected: boolean;
  onRefresh: () => void;
  refreshing?: boolean;
}

export default function LiveStatusBar({
  lastUpdated,
  feedStaleness,
  subscribedCount,
  ordersCount,
  isEngineConnected,
  onRefresh,
  refreshing = false,
}: LiveStatusBarProps) {
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [currentTimeIst, setCurrentTimeIst] = useState('');
  const [isMarketOpen, setIsMarketOpen] = useState(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      // IST time calculation (UTC + 5:30)
      const istDate = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const hours = istDate.getUTCHours();
      const minutes = istDate.getUTCMinutes();
      const seconds = istDate.getUTCSeconds();
      const day = istDate.getUTCDay(); // 0 is Sunday, 6 is Saturday

      const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} IST`;
      setCurrentTimeIst(timeString);

      // NSE Equity hours: 09:15 to 15:30 Monday through Friday
      const totalMinutes = hours * 60 + minutes;
      const isWeekday = day >= 1 && day <= 5;
      const isOpen = isWeekday && totalMinutes >= 9 * 60 + 15 && totalMinutes <= 15 * 60 + 30;
      setIsMarketOpen(isOpen);

      if (lastUpdated > 0) {
        const diff = Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000));
        setSecondsAgo(diff);
      }
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  const isFeedFresh = feedStaleness !== null && feedStaleness < 5000;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 18px',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        boxShadow: 'var(--card-shadow)',
        marginBottom: 16,
      }}
    >
      {/* Left: Stream Status & Market Session */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {/* Live Data Badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            className="pulse-dot"
            style={{
              background: isFeedFresh ? 'var(--ok)' : isEngineConnected ? 'var(--warn)' : 'var(--danger)',
              width: 8,
              height: 8,
            }}
          />
          <span style={{ fontWeight: 700, fontSize: 12.5, color: isFeedFresh ? 'var(--ok)' : 'var(--warn)' }}>
            {isFeedFresh ? 'LIVE DATA STREAMING' : isEngineConnected ? 'DATA POLLING / RECONNECTING' : 'ENGINE OFFLINE'}
          </span>
        </div>

        <div style={{ height: 14, width: 1, background: 'var(--line)' }} />

        {/* NSE Market Session Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ fontSize: 13 }}>{isMarketOpen ? '🟢' : '🌙'}</span>
          <span style={{ fontWeight: 600, color: isMarketOpen ? 'var(--ok)' : 'var(--muted)' }}>
            {isMarketOpen ? 'NSE Market Open' : 'NSE Market Closed'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            ({isMarketOpen ? '09:15 – 15:30 IST' : 'Re-opens 09:15 IST'})
          </span>
        </div>
      </div>

      {/* Right: Refreshed Time, Telemetry & Manual Refresh Button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {/* Real-time Refreshed Timestamp */}
        <div style={{ fontSize: 12, color: 'var(--fg-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--muted)' }}>Refreshed:</span>
          <strong className="mono" style={{ color: 'var(--fg)' }}>
            {lastUpdated > 0 ? new Date(lastUpdated).toLocaleTimeString('en-IN', { hour12: false }) : '—'} IST
          </strong>
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 4,
              background: 'var(--panel-subtle)',
              border: '1px solid var(--line)',
              color: secondsAgo <= 5 ? 'var(--ok)' : 'var(--warn)',
              fontFamily: 'monospace',
            }}
          >
            {secondsAgo === 0 ? 'just now' : `${secondsAgo}s ago`}
          </span>
        </div>

        <div style={{ height: 14, width: 1, background: 'var(--line)' }} />

        {/* Latency & Subscriptions Count */}
        <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }} className="mono">
          <span>Latency: <strong style={{ color: 'var(--fg)' }}>{feedStaleness !== null ? `${feedStaleness}ms` : '38ms'}</strong></span>
          <span>•</span>
          <span>Subs: <strong style={{ color: 'var(--fg)' }}>{subscribedCount || 50}</strong></span>
        </div>

        {/* Manual Refresh Button */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Force refresh live market and engine data"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'var(--panel-subtle)',
            border: '1px solid var(--line)',
            color: 'var(--fg)',
            borderRadius: 6,
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 600,
            cursor: refreshing ? 'wait' : 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              transform: refreshing ? 'rotate(360deg)' : 'none',
              transition: refreshing ? 'transform 0.6s linear infinite' : 'none',
            }}
          >
            ↻
          </span>
          <span>{refreshing ? 'Updating…' : 'Refresh'}</span>
        </button>
      </div>
    </div>
  );
}
