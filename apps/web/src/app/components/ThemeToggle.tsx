'use client';

import React, { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem('tf-theme') as Theme | null;
      if (stored === 'light' || stored === 'dark') {
        setTheme(stored);
      } else {
        setTheme('system');
      }
    } catch {}

    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'tf-theme') {
        const next = (e.newValue as Theme | null) ?? 'system';
        setTheme(next);
        applyTheme(next);
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const applyTheme = (t: Theme) => {
    try {
      const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;
      if (t === 'system') {
        localStorage.removeItem('tf-theme');
        document.documentElement.dataset.theme = 'system';
        if (meta) meta.content = 'light dark';
      } else {
        localStorage.setItem('tf-theme', t);
        document.documentElement.dataset.theme = t;
        if (meta) meta.content = t;
      }
    } catch {}
  };

  const selectTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  if (!mounted) {
    // Server render placeholder to prevent layout shift & hydration mismatch
    return (
      <div
        style={{
          width: 104,
          height: 28,
          borderRadius: 999,
          background: 'var(--panel-subtle)',
          border: '1px solid var(--line)',
        }}
      />
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--panel-subtle)',
        border: '1px solid var(--line)',
        borderRadius: 999,
        padding: '2px',
        gap: '2px',
      }}
    >
      {/* Light option */}
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'light'}
        aria-label="Light mode"
        title="Light mode"
        onClick={() => selectTheme('light')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 24,
          padding: 0,
          borderRadius: 999,
          border: 'none',
          cursor: 'pointer',
          background: theme === 'light' ? 'var(--panel)' : 'transparent',
          color: theme === 'light' ? 'var(--accent)' : 'var(--muted)',
          boxShadow: theme === 'light' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      </button>

      {/* Dark option */}
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'dark'}
        aria-label="Dark mode"
        title="Dark mode"
        onClick={() => selectTheme('dark')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 24,
          padding: 0,
          borderRadius: 999,
          border: 'none',
          cursor: 'pointer',
          background: theme === 'dark' ? 'var(--panel)' : 'transparent',
          color: theme === 'dark' ? 'var(--accent)' : 'var(--muted)',
          boxShadow: theme === 'dark' ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>

      {/* System option */}
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'system'}
        aria-label="System color scheme"
        title="System color scheme (Auto)"
        onClick={() => selectTheme('system')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 24,
          padding: 0,
          borderRadius: 999,
          border: 'none',
          cursor: 'pointer',
          background: theme === 'system' ? 'var(--panel)' : 'transparent',
          color: theme === 'system' ? 'var(--accent)' : 'var(--muted)',
          boxShadow: theme === 'system' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      </button>
    </div>
  );
}
