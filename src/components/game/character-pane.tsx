'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import { categorizeInventory, formatInventoryDisplay, slugToLabel } from '@/lib/inventory';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';
import type { MasterInventoryView } from '@/srd/enrich-inventory';
import { ClassFeatures } from './class-features';

// Classes that learn spells at any level. Used to decide whether to render
// the Spells section even when `character.spellcasting` is null (e.g. older
// characters created before deriveCharacter populated the field).
const SPELLCASTER_CLASSES = new Set([
  'bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard',
]);

export interface CharacterPaneProps {
  character: Character;
  state: SessionStateRow;
  enrichedInventory?: MasterInventoryView[];
  /** When true the pane drops desktop sidebar chrome and renders as drawer content. */
  compact?: boolean;
}

export function CharacterPane({ character, state, enrichedInventory, compact = false }: CharacterPaneProps) {
  const hpPct = character.hpMax > 0 ? Math.round((state.hpCurrent / character.hpMax) * 100) : 0;
  const hpTone = hpPct <= 25 ? 'var(--ember)' : hpPct <= 50 ? 'var(--gold)' : 'var(--verdigris)';

  return (
    <aside
      style={{
        width: compact ? '100%' : 280,
        padding: 18,
        borderRight: compact ? '' : '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        flexShrink: 0,
        // Span the viewport vertically (minus the 56px sticky topbar) instead
        // of collapsing to content. The pane scrolls internally when its
        // sections overflow, but the chrome itself always reaches the bottom.
        // In compact mode (drawer), sticky chrome is removed.
        ...(compact ? {} : { position: 'sticky', top: 56, height: 'calc(100vh - 56px)', overflowY: 'auto' }),
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
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1.1, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{character.name}</span>
            {character.inspiration === true && (
              <span
                aria-label="Has Inspiration"
                title="Has Inspiration — spend for ADV on one d20 roll"
                style={{ color: 'var(--gold)', fontSize: 18, lineHeight: 1 }}
              >
                ★
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {character.raceSlug} · {formatClassBreakdown(character)}
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

      <SensesSection senses={character.senses} />
      <AttunementSection attunedItems={character.attunedItems} />
      <EquippedFocusSection focus={character.equippedFocus} />

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
              <Chip key={c.slug} tone="warn" dot>
                {c.slug}
                {typeof c.durationRounds === 'number' && c.durationRounds > 0 && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.75, marginLeft: 4 }}>
                    ({c.durationRounds} {c.durationRounds === 1 ? 'rd' : 'rds'})
                  </span>
                )}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {SPELLCASTER_CLASSES.has(character.classSlug) && (
        <SpellsSection
          spellsKnown={character.spellcasting?.spellsKnown ?? []}
          spellsPrepared={character.spellcasting?.spellsPrepared ?? []}
        />
      )}

      <ClassFeatures character={character} state={state} />

      <InventorySection inventory={character.inventory} enriched={enrichedInventory} />
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

/**
 * PHB §2.5 — render the class breakdown. For a single-class PC this is just
 * "fighter 3" (legacy fallback); for a multiclass PC it joins entries as
 * "fighter 3 / wizard 2". Capitalises the slug for display.
 */
function formatClassBreakdown(character: Character): string {
  const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  if (character.classes && character.classes.length > 0) {
    return character.classes.map((c) => `${cap(c.slug)} ${c.level}`).join(' / ');
  }
  return `${cap(character.classSlug)} ${character.level}`;
}

/**
 * PHB §6.4 — render the senses block. Shows only present senses, each as a
 * compact "Darkvision 60 ft" line. Hidden entirely when no senses are set.
 */
function SensesSection({ senses }: { senses?: Character['senses'] }) {
  if (!senses) return null;
  const entries: string[] = [];
  if (senses.darkvisionFt) entries.push(`Darkvision ${senses.darkvisionFt} ft`);
  if (senses.blindsightFt) entries.push(`Blindsight ${senses.blindsightFt} ft`);
  if (senses.tremorsenseFt) entries.push(`Tremorsense ${senses.tremorsenseFt} ft`);
  if (senses.truesightFt) entries.push(`Truesight ${senses.truesightFt} ft`);
  if (entries.length === 0) return null;
  return (
    <div>
      <Eyebrow style={{ marginBottom: 6 }}>Senses</Eyebrow>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {entries.map((label) => (
          <Chip key={label} tone="neutral">{label}</Chip>
        ))}
      </div>
    </div>
  );
}

/**
 * PHB §10.1 — show the attunement count (capped at 3) plus the slug list.
 * Hidden entirely when nothing is attuned.
 */
function AttunementSection({ attunedItems }: { attunedItems?: string[] }) {
  if (!attunedItems || attunedItems.length === 0) return null;
  return (
    <div>
      <Eyebrow style={{ marginBottom: 6 }}>Attuned: {attunedItems.length}/3</Eyebrow>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {attunedItems.map((slug) => (
          <Chip key={slug} tone="accent">{slugToLabel(slug)}</Chip>
        ))}
      </div>
    </div>
  );
}

const FOCUS_LABEL: Record<'arcane' | 'druidic' | 'holy' | 'instrument', string> = {
  arcane: 'Arcane',
  druidic: 'Druidic',
  holy: 'Holy',
  instrument: 'Instrument',
};

/**
 * PHB §8.4 — show the held spellcasting focus as a compact "Holy: emblem-pelor"
 * style chip. Hidden when no focus is declared.
 */
function EquippedFocusSection({ focus }: { focus?: Character['equippedFocus'] }) {
  if (!focus) return null;
  return (
    <div>
      <Eyebrow style={{ marginBottom: 6 }}>Focus</Eyebrow>
      <Chip tone="gold">{FOCUS_LABEL[focus.kind]}: {slugToLabel(focus.itemSlug)}</Chip>
    </div>
  );
}

const CURRENCY_COLOR: Record<string, string> = {
  pp: 'var(--bone)',
  gp: 'var(--gold)',
  ep: 'var(--gold)',
  sp: 'var(--fg-muted)',
  cp: 'var(--ember)',
};

function InventorySection({
  inventory,
  enriched,
}: {
  inventory: { slug: string; qty: number; equipped: boolean }[];
  enriched?: MasterInventoryView[];
}) {
  const cat = categorizeInventory(inventory);
  const totalCount = cat.currency.length + cat.equipped.length + cat.other.length;

  // Index enriched rows by slug so InventoryRow lookups are O(1).
  const enrichedMap = React.useMemo(() => {
    const m = new Map<string, MasterInventoryView>();
    for (const e of enriched ?? []) m.set(e.slug, e);
    return m;
  }, [enriched]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {cat.currency.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Currency</Eyebrow>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {cat.currency.map(({ code, qty }) => (
              <div
                key={code}
                style={{
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  gap: 4,
                  padding: '3px 8px',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span style={{ fontWeight: 600 }}>{qty.toLocaleString()}</span>
                <span style={{ fontSize: 10, color: CURRENCY_COLOR[code] ?? 'var(--fg-muted)', textTransform: 'uppercase' }}>{code}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {cat.equipped.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Equipped</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {cat.equipped.map((it) => (
              <InventoryRow key={it.slug} slug={it.slug} qty={it.qty} equipped enriched={enrichedMap.get(it.slug)} />
            ))}
          </div>
        </div>
      )}

      {cat.other.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Inventory</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {cat.other.map((it) => (
              <InventoryRow key={it.slug} slug={it.slug} qty={it.qty} equipped={false} enriched={enrichedMap.get(it.slug)} />
            ))}
          </div>
        </div>
      )}

      {totalCount === 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Inventory</Eyebrow>
          <div
            style={{
              padding: '8px 10px',
              background: 'var(--bg-card)',
              border: '1px dashed var(--border)',
              borderRadius: 6,
              fontSize: 12,
              fontStyle: 'italic',
              color: 'var(--fg-muted)',
              lineHeight: 1.4,
            }}
          >
            Empty for now. The master adds items as you find or buy them.
          </div>
        </div>
      )}
    </div>
  );
}

function InventoryRow({
  slug, qty, equipped, enriched,
}: {
  slug: string;
  qty: number;
  equipped: boolean;
  enriched?: MasterInventoryView;
}) {
  const { label } = formatInventoryDisplay(slug, enriched);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        padding: '3px 6px',
        borderRadius: 4,
        background: equipped ? 'rgba(122,79,184,0.08)' : 'transparent',
        border: equipped ? '1px solid rgba(122,79,184,0.3)' : '1px solid transparent',
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {qty > 1 && (
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
          ×{qty}
        </span>
      )}
    </div>
  );
}

function SpellsSection({ spellsKnown, spellsPrepared }: { spellsKnown: string[]; spellsPrepared: string[] }) {
  if (spellsKnown.length === 0) {
    return (
      <div>
        <Eyebrow style={{ marginBottom: 6 }}>Spells</Eyebrow>
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border)',
            borderRadius: 6,
            fontSize: 12,
            fontStyle: 'italic',
            color: 'var(--fg-muted)',
            lineHeight: 1.4,
          }}
        >
          No spells known yet.
        </div>
      </div>
    );
  }

  const preparedSet = new Set(spellsPrepared);
  // Show "prep" indicator only when the class actually distinguishes prepared
  // from known (i.e. the prepared list is a non-empty proper subset). For
  // know-everything casters (sorcerer, warlock) the two arrays are equal —
  // highlighting every row would be noise.
  const showsPrepared =
    spellsPrepared.length > 0 && spellsPrepared.length < spellsKnown.length;

  const sorted = [...spellsKnown].sort((a, b) => a.localeCompare(b));

  return (
    <div>
      <Eyebrow style={{ marginBottom: 6 }}>Spells</Eyebrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {sorted.map((slug) => {
          const isPrepared = preparedSet.has(slug);
          const highlight = showsPrepared && isPrepared;
          return (
            <div
              key={slug}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                padding: '3px 6px',
                borderRadius: 4,
                background: highlight ? 'rgba(122,79,184,0.08)' : 'transparent',
                border: highlight ? '1px solid rgba(122,79,184,0.3)' : '1px solid transparent',
              }}
            >
              <span style={{ flex: 1 }}>{slugToLabel(slug)}</span>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
