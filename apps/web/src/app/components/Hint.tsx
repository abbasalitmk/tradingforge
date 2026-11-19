'use client';

import React, { useState, useRef, useEffect } from 'react';

interface HintProps {
  term: string;
  explanation: string;
  example?: string;
  children?: React.ReactNode;
}

export default function Hint({ term, explanation, example, children }: HintProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKey);
    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {children && (
        <span
          style={{
            borderBottom: '1px dotted var(--muted)',
            cursor: 'help',
          }}
          onClick={() => setOpen((prev) => !prev)}
        >
          {children}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        aria-label={`What is ${term}?`}
        title={`Click for beginner explanation of ${term}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 15,
          height: 15,
          borderRadius: '50%',
          border: '1px solid var(--line-strong)',
          background: 'var(--panel-subtle)',
          color: 'var(--muted)',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'system-ui, sans-serif',
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1,
          transition: 'all 0.15s ease',
          verticalAlign: 'middle',
        }}
      >
        ?
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 1000,
            bottom: 'calc(100% + 8px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 260,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '10px 14px',
            boxShadow: 'var(--modal-shadow)',
            color: 'var(--fg)',
            fontSize: 12,
            lineHeight: 1.45,
            pointerEvents: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--accent)' }}>💡 {term}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 12,
                padding: '0 2px',
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ color: 'var(--fg-secondary)', fontSize: 11.5 }}>{explanation}</div>
          {example && (
            <div
              style={{
                marginTop: 6,
                padding: '4px 8px',
                borderRadius: 6,
                background: 'var(--panel-subtle)',
                border: '1px solid var(--line)',
                fontSize: 10.5,
                color: 'var(--muted)',
              }}
            >
              <strong>Example:</strong> {example}
            </div>
          )}
          {/* Arrow pointer */}
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid var(--line)',
            }}
          />
        </div>
      )}
    </span>
  );
}
