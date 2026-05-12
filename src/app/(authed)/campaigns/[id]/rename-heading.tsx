'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Blur cancels (no save) — Enter is required to save.
// This avoids the Escape→blur race where blur fires after cancel and
// would re-trigger a save with the partially-edited value.

export function RenameHeading({ campaignId, initialName }: { campaignId: string; initialName: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
      setSaving(false);
    }
  };

  const cancel = () => {
    setName(initialName);
    setError(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <h1
        onClick={() => setEditing(true)}
        style={{
          fontSize: 36, fontWeight: 600, lineHeight: 1.1,
          cursor: 'pointer',
          borderBottom: '1px dashed transparent',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderBottomColor = 'var(--border)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
        title="Click to rename"
      >
        {name}
      </h1>
    );
  }

  return (
    <div>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={cancel}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            cancel();
          }
        }}
        disabled={saving}
        style={{
          fontSize: 36, fontWeight: 600, lineHeight: 1.1,
          background: 'transparent', color: 'inherit',
          border: 'none', borderBottom: '2px solid var(--accent)',
          outline: 'none', padding: '2px 0',
          width: '100%', fontFamily: 'inherit',
        }}
      />
      {error && (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--danger)' }}>
          Error: {error}
        </div>
      )}
    </div>
  );
}
