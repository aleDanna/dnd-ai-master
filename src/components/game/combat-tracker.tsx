'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import type { CombatActorRow, SessionStateRow } from '@/sessions/client-types';

export interface CombatTrackerProps {
  state: Pick<SessionStateRow, 'inCombat' | 'combat'>;
  actors: CombatActorRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpCurrent: number;
  pcHpMax: number;
  /** Optional escape hatch invoked when the player clicks "End combat".
   *  When omitted the button is hidden — useful for tests that don't
   *  care about the manual override. */
  onEndCombat?: () => void;
}

interface TurnRow {
  actorId: string;
  name: string;
  init: number;
  hp: number;
  hpMax: number;
  alive: boolean;
  current: boolean;
}

export function CombatTracker({ state, actors, pcCharacterId, pcName, pcHpCurrent, pcHpMax, onEndCombat }: CombatTrackerProps) {
  if (!state.inCombat || !state.combat) {
    return (
      <section>
        <Eyebrow style={{ marginBottom: 8 }}>Exploration</Eyebrow>
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--fg)',
          }}
        >
          No active combat. The Master may call for skill checks.
        </div>
      </section>
    );
  }

  const order: TurnRow[] = state.combat.turnOrder.map((t, idx) => {
    if (t.actorId === pcCharacterId) {
      return { actorId: t.actorId, name: pcName, init: t.initiative, hp: pcHpCurrent, hpMax: pcHpMax, alive: pcHpCurrent > 0, current: idx === state.combat!.currentIdx };
    }
    const a = actors.find((x) => x.id === t.actorId);
    return {
      actorId: t.actorId,
      name: a?.name ?? '???',
      init: t.initiative,
      hp: a?.hpCurrent ?? 0,
      hpMax: a?.hpMax ?? 0,
      alive: a?.isAlive ?? false,
      current: idx === state.combat!.currentIdx,
    };
  });

  const currentIsPc = order[state.combat.currentIdx]?.actorId === pcCharacterId;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <Eyebrow>Combat · Round {state.combat.round}</Eyebrow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {currentIsPc && <Chip tone="warn" dot>Your turn</Chip>}
          {onEndCombat && (
            <button
              type="button"
              onClick={onEndCombat}
              title="Force-end combat — clears the tracker. Use if the master forgot to call end_combat."
              style={{
                padding: '2px 8px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 999,
                color: 'var(--fg-subtle)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              End
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {order.map((a) => (
          <div
            key={a.actorId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              background: a.current ? 'rgba(122,79,184,0.14)' : 'transparent',
              border: a.current ? '1px solid rgba(122,79,184,0.40)' : '1px solid transparent',
            }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)', width: 22, textAlign: 'right' }}>{a.init}</span>
            <span style={{ flex: 1, fontSize: 13, color: a.alive ? 'var(--fg)' : 'var(--fg-subtle)', textDecoration: a.alive ? 'none' : 'line-through' }}>{a.name}</span>
            {a.alive ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{a.hp}/{a.hpMax}</span>
                <div style={{ width: 56, height: 3, background: 'var(--bg-sunken)', borderRadius: 2, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${a.hpMax > 0 ? Math.round((a.hp / a.hpMax) * 100) : 0}%`,
                      background: a.hpMax > 0 && a.hp / a.hpMax <= 0.25 ? 'var(--ember)' : 'var(--verdigris)',
                    }}
                  />
                </div>
              </div>
            ) : (
              <span style={{ fontSize: 10, color: 'var(--ember)', fontFamily: 'var(--font-mono)' }}>down</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
