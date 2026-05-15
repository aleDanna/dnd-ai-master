'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { slugToLabel } from '@/lib/inventory';
import { SpellSlotsTile } from './class-features';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

export interface SpellbookModalProps {
  character: Character;
  state: SessionStateRow;
  onClose: () => void;
}

/**
 * Read-only spellbook view: spell save DC, spell attack bonus, the full
 * slot grid, and the list of known spells with a "prep" indicator for the
 * subset currently prepared (when the class distinguishes the two).
 *
 * Separate from `SpellModal` (which is the active casting flow): this modal
 * exists so the character pane can collapse the inline spell list into a
 * single "Spells" entry — clicking opens this view so the player can review
 * everything in one place without scrolling the side panel.
 */
export function SpellbookModal({ character, state, onClose }: SpellbookModalProps) {
  const [query, setQuery] = React.useState('');
  const spellcasting = character.spellcasting;
  const slotsMax = spellcasting?.slotsMax ?? {};
  const slotsUsed = state.spellSlotsUsed ?? {};
  const hasSlots = Object.keys(slotsMax).length > 0;
  const spellsKnown = spellcasting?.spellsKnown ?? [];
  const spellsPrepared = spellcasting?.spellsPrepared ?? [];
  const preparedSet = React.useMemo(() => new Set(spellsPrepared), [spellsPrepared]);
  // "Prep" indicator only when the class actually distinguishes prepared
  // from known (i.e. prepared is a non-empty proper subset of known).
  // Sorcerers/warlocks have prepared == known, so the badge would be noise.
  const showsPrepared =
    spellsPrepared.length > 0 && spellsPrepared.length < spellsKnown.length;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...spellsKnown].sort((a, b) => a.localeCompare(b));
    if (!q) return sorted;
    return sorted.filter((slug) => slugToLabel(slug).toLowerCase().includes(q));
  }, [spellsKnown, query]);

  // ESC closes the modal.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Spellbook"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        zIndex: 50,
        padding: 16,
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
          width: 'min(520px, 100%)',
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
          boxShadow: 'var(--shadow-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <Eyebrow>Spellbook</Eyebrow>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 22,
                fontWeight: 600,
                marginTop: 4,
                lineHeight: 1.1,
              }}
            >
              {character.name}
            </h3>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              {character.raceSlug} · {character.classSlug} Lv {character.level}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close spellbook"
            style={{
              flexShrink: 0,
              width: 32,
              height: 32,
              borderRadius: 6,
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </header>

        {spellcasting && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <StatTile
              label="Save DC"
              value={spellcasting.spellSaveDC}
              hint={`Spell save DC against your ${abilityLabel(spellcasting.ability)}`}
            />
            <StatTile
              label="Spell atk"
              value={`${spellcasting.spellAttackBonus >= 0 ? '+' : ''}${spellcasting.spellAttackBonus}`}
              hint="Modifier added to spell attack rolls"
            />
          </div>
        )}

        {hasSlots && (
          <SpellSlotsTile
            slots={slotsMax as Record<string, number>}
            used={slotsUsed}
            recharge={character.classSlug === 'warlock' ? 'short' : 'long'}
          />
        )}

        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Eyebrow>Known spells</Eyebrow>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>
              {spellsKnown.length}
              {showsPrepared && ` · ${spellsPrepared.length} prepared`}
            </span>
          </div>

          {spellsKnown.length === 0 ? (
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--bg-elev)',
                border: '1px dashed var(--border)',
                borderRadius: 6,
                fontSize: 12,
                fontStyle: 'italic',
                color: 'var(--fg-muted)',
                lineHeight: 1.4,
                marginTop: 8,
              }}
            >
              No spells known yet.
            </div>
          ) : (
            <>
              {spellsKnown.length > 6 && (
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name…"
                  aria-label="Filter spells"
                  style={{
                    width: '100%',
                    marginTop: 8,
                    padding: '8px 10px',
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: 'var(--fg)',
                    fontFamily: 'inherit',
                    fontSize: 13,
                  }}
                />
              )}

              <ul
                style={{
                  marginTop: 8,
                  listStyle: 'none',
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {filtered.length === 0 ? (
                  <li
                    style={{
                      padding: '8px 10px',
                      fontSize: 12,
                      fontStyle: 'italic',
                      color: 'var(--fg-muted)',
                    }}
                  >
                    No matches.
                  </li>
                ) : (
                  filtered.map((slug) => {
                    const isPrepared = preparedSet.has(slug);
                    const highlight = showsPrepared && isPrepared;
                    return (
                      <li
                        key={slug}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: highlight ? 'rgba(122,79,184,0.08)' : 'var(--bg-elev)',
                          border: '1px solid ' + (highlight ? 'rgba(122,79,184,0.3)' : 'var(--border)'),
                        }}
                      >
                        <Icon name="spell" size={12} style={{ color: highlight ? 'var(--arcane)' : 'var(--fg-subtle)' }} />
                        <span style={{ flex: 1, minWidth: 0 }}>{slugToLabel(slug)}</span>
                        {highlight && (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--arcane)',
                              fontSize: 9,
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                            }}
                          >
                            prep
                          </span>
                        )}
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          )}
        </section>

        <footer style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="md" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div
      title={hint}
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function abilityLabel(ability: string): string {
  const map: Record<string, string> = {
    STR: 'Strength',
    DEX: 'Dexterity',
    CON: 'Constitution',
    INT: 'Intelligence',
    WIS: 'Wisdom',
    CHA: 'Charisma',
  };
  return map[ability] ?? ability;
}
