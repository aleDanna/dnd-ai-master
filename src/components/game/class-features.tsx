'use client';
import { Icon, type IconName } from '@/components/ui/icon';
import { slugToLabel } from '@/lib/inventory';
import {
  CLASS_GLYPH,
  CLASS_RESOURCE_META,
  DEFAULT_GLYPH,
  type ClassGlyph,
  type RestKind,
} from './class-resources-meta';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

export interface ClassFeaturesProps {
  character: Character;
  state: SessionStateRow;
}

/**
 * The "loud" section under the character pane: class glyph header, then a
 * tile per counted/pool feature with a rest-chip (SR/LR/ENC), accent-colored
 * pips, and a hint. Spell slots used to render here too; they now live
 * inside the Spellbook modal, surfaced via the `SpellbookCard` entry in the
 * character pane.
 */
export function ClassFeatures({ character, state }: ClassFeaturesProps) {
  const glyph = CLASS_GLYPH[character.classSlug] ?? DEFAULT_GLYPH;
  const countedFeatures = character.features.filter((f) => f.usesMax !== 'unlimited');

  if (countedFeatures.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <ClassFeaturesHeader glyph={glyph} level={character.level} />

      {countedFeatures.map((f) => (
        <ResourceTile
          key={f.slug}
          slug={f.slug}
          max={f.usesMax === 'unlimited' ? 0 : f.usesMax}
          used={state.resourcesUsed[f.slug] ?? 0}
          accent={glyph.accent}
        />
      ))}
    </div>
  );
}

function ClassFeaturesHeader({ glyph, level }: { glyph: ClassGlyph; level: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 0 8px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: `${glyph.accent}22`,
          border: `1px solid ${glyph.accent}55`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: glyph.accent,
          flexShrink: 0,
        }}
      >
        <Icon name={glyph.icon} size={15} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--fg-subtle)',
            lineHeight: 1,
          }}
        >
          Class features
        </div>
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            fontWeight: 600,
            marginTop: 2,
          }}
        >
          {glyph.label}{' '}
          <span
            style={{
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 400,
            }}
          >
            Lv {level}
          </span>
        </div>
      </div>
    </div>
  );
}

interface RestTone {
  bg: string;
  fg: string;
  icon: IconName;
  short: string;
}

const REST_TONE: Record<RestKind, RestTone> = {
  short: { bg: 'rgba(230,138,44,0.10)', fg: 'var(--ember)', icon: 'campfire', short: 'SR' },
  long:  { bg: 'rgba(122,79,184,0.12)', fg: 'var(--arcane-2)', icon: 'moon', short: 'LR' },
  encounter: { bg: 'rgba(215,51,28,0.10)', fg: 'var(--dragonfire)', icon: 'sword', short: 'ENC' },
};

export function RestChip({ rest }: { rest: RestKind }) {
  const t = REST_TONE[rest];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
      title={`Recovers on a ${rest === 'encounter' ? 'new encounter' : `${rest} rest`}`}
    >
      <Icon name={t.icon} size={9} />
      {t.short}
    </span>
  );
}

export function SpellSlotsTile({
  slots,
  used,
  recharge,
}: {
  slots: Record<string, number>;
  used: Record<string, number>;
  recharge: RestKind;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
          <Icon name="spell" size={12} style={{ color: 'var(--arcane-2)' }} />
          <span>Spell slots</span>
        </div>
        <RestChip rest={recharge} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Object.entries(slots).map(([level, max]) => {
          const usedN = used[level] ?? 0;
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
                      transform: 'rotate(45deg)',
                      borderRadius: 2,
                      border: '1.5px solid var(--arcane)',
                      background: i < usedN ? 'transparent' : 'var(--arcane)',
                    }}
                  />
                ))}
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--fg-subtle)',
                  minWidth: 28,
                  textAlign: 'right',
                }}
              >
                {max - usedN}/{max}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResourceTile({
  slug,
  max,
  used,
  accent,
}: {
  slug: string;
  max: number;
  used: number;
  accent: string;
}) {
  const meta = CLASS_RESOURCE_META[slug];
  const remaining = max - used;
  const available = remaining > 0;
  const name = meta?.name ?? slugToLabel(slug);
  const icon = meta?.icon;
  const recharge = meta?.recharge ?? 'long';
  const hint = meta?.hint;
  const action = meta?.action;
  const kind = meta?.kind ?? 'pip';
  const unit = meta?.poolUnit ?? 'pool';

  if (kind === 'pool') {
    const pct = max > 0 ? Math.round((remaining / max) * 100) : 0;
    return (
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderLeft: `3px solid ${accent}`,
          borderRadius: 8,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          opacity: available ? 1 : 0.55,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
            {icon && <Icon name={icon} size={12} style={{ color: accent }} />}
            <span>{name}</span>
          </div>
          <RestChip rest={recharge} />
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>
          <span style={{ color: 'var(--fg)', fontWeight: 600, fontSize: 13 }}>{remaining}</span>
          <span>/ {max}</span>
          <span style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>{unit}</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-sunken)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: accent, transition: 'width 220ms' }} />
        </div>
        {hint && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              lineHeight: 1.4,
              fontStyle: 'italic',
              fontFamily: 'var(--font-display)',
            }}
          >
            {hint}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${available ? accent : 'var(--border-strong)'}`,
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        opacity: available ? 1 : 0.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
          {icon && <Icon name={icon} size={12} style={{ color: accent }} />}
          <span>{name}</span>
        </div>
        <RestChip rest={recharge} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', gap: 3, flex: 1, flexWrap: 'wrap' }}>
          {Array.from({ length: max }).map((_, i) => {
            const filled = i < remaining;
            return (
              <div
                key={i}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: `1.5px solid ${filled ? accent : 'var(--border-strong)'}`,
                  background: filled ? accent : 'transparent',
                  transition: 'all 160ms',
                }}
              />
            );
          })}
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-subtle)' }}>{remaining}/{max}</span>
      </div>
      {hint && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--fg-muted)',
            lineHeight: 1.4,
            fontStyle: 'italic',
            fontFamily: 'var(--font-display)',
          }}
        >
          {hint}
        </div>
      )}
      {available ? (
        action ? (
          <span
            style={{
              alignSelf: 'flex-start',
              padding: '3px 12px',
              background: `${accent}18`,
              border: `1px solid ${accent}`,
              color: accent,
              borderRadius: 999,
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {action}
          </span>
        ) : null
      ) : (
        <span
          style={{
            alignSelf: 'flex-start',
            padding: '3px 10px',
            background: 'transparent',
            border: '1px dashed var(--border-strong)',
            color: 'var(--fg-subtle)',
            borderRadius: 999,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          Spent
        </span>
      )}
    </div>
  );
}
