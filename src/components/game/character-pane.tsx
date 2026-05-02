'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

export interface CharacterPaneProps {
  character: Character;
  state: SessionStateRow;
}

export function CharacterPane({ character, state }: CharacterPaneProps) {
  const hpPct = character.hpMax > 0 ? Math.round((state.hpCurrent / character.hpMax) * 100) : 0;
  const hpTone = hpPct <= 25 ? 'var(--ember)' : hpPct <= 50 ? 'var(--gold)' : 'var(--verdigris)';

  return (
    <aside
      style={{
        width: 280,
        padding: 18,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        overflowY: 'auto',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 8,
            background: 'var(--bone)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontStyle: 'italic',
            fontWeight: 600,
          }}
        >
          {character.name[0]}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>{character.name}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {character.raceSlug} · {character.classSlug} {character.level}
          </div>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Eyebrow>Hit Points</Eyebrow>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600 }}>{state.hpCurrent} / {character.hpMax}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-sunken)', marginTop: 6, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, hpPct))}%`, background: hpTone, transition: 'width 220ms' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <Stat label="AC" value={character.ac} />
        <Stat label="Speed" value={`${character.speed}'`} />
        <Stat label="PB" value={`+${character.proficiencyBonus}`} />
      </div>

      <div>
        <Eyebrow style={{ marginBottom: 6 }}>Abilities</Eyebrow>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4 }}>
          {(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const).map((k) => {
            const v = character.abilities[k];
            const mod = Math.floor((v - 10) / 2);
            return (
              <div
                key={k}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 0',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{k}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 600 }}>{v}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{mod >= 0 ? '+' : ''}{mod}</div>
              </div>
            );
          })}
        </div>
      </div>

      {state.conditions.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Conditions</Eyebrow>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {state.conditions.map((c) => (
              <Chip key={c.slug} tone="warn" dot>{c.slug}</Chip>
            ))}
          </div>
        </div>
      )}

      {character.spellcasting && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Spell slots</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(character.spellcasting.slotsMax).map(([level, max]) => {
              const used = state.spellSlotsUsed[level] ?? 0;
              return (
                <div key={level} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ width: 28, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>Lv {level}</span>
                  <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                    {Array.from({ length: max }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: '1.5px solid var(--arcane)',
                          background: i < used ? 'transparent' : 'var(--arcane)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {character.features.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Resources</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {character.features
              .filter((f) => f.usesMax !== 'unlimited')
              .map((f) => {
                const used = state.resourcesUsed[f.slug] ?? 0;
                const max = f.usesMax === 'unlimited' ? 0 : f.usesMax;
                return (
                  <div key={f.slug} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span>{f.slug}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{max - used} / {max}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
