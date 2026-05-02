'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';

export interface SpellSlotInfo {
  level: number;
  used: number;
  max: number;
}

export interface SpellModalProps {
  spellsKnown: string[];
  slots: SpellSlotInfo[];
  onCast: (spellSlug: string, slotLevel: number) => void;
  onClose: () => void;
}

export function SpellModal({ spellsKnown, slots, onCast, onClose }: SpellModalProps) {
  const [selectedSpell, setSelectedSpell] = React.useState<string | null>(spellsKnown[0] ?? null);
  const availableSlots = slots.filter((s) => s.max > s.used);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        zIndex: 10,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          padding: 24,
          width: 480,
          boxShadow: 'var(--shadow-3)',
        }}
      >
        <Eyebrow>Cast a spell</Eyebrow>
        <h3 style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600, marginTop: 4 }}>
          {selectedSpell ?? 'No spells known'}
        </h3>

        {spellsKnown.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <Eyebrow>Known spells</Eyebrow>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {spellsKnown.map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedSpell(s)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: selectedSpell === s ? 'var(--bone)' : 'var(--bg-elev)',
                    color: selectedSpell === s ? 'var(--ink)' : 'var(--fg)',
                    border: '1px solid ' + (selectedSpell === s ? 'var(--bone)' : 'var(--border)'),
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Eyebrow>Choose a slot</Eyebrow>
          {availableSlots.length === 0 ? (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-muted)' }}>No slots available — take a long rest.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {availableSlots.map((s) => (
                <button
                  key={s.level}
                  onClick={() => selectedSpell && onCast(selectedSpell, s.level)}
                  disabled={!selectedSpell}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    cursor: selectedSpell ? 'pointer' : 'not-allowed',
                    opacity: selectedSpell ? 1 : 0.4,
                    color: 'inherit',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>Lv {s.level}</span>
                  <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                    {Array.from({ length: s.max }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: '1.5px solid var(--arcane)',
                          background: i < s.used ? 'transparent' : 'var(--arcane)',
                        }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{s.max - s.used} left</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
