'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import type { CombatActorRow, SessionStateRow } from '@/sessions/client-types';

type TurnState = NonNullable<SessionStateRow['turnState']>;
type Position = NonNullable<SessionStateRow['position']>;
type ConditionInstance = SessionStateRow['conditions'][number];

export interface CombatTrackerProps {
  state: Pick<SessionStateRow, 'inCombat' | 'combat'>;
  actors: CombatActorRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpCurrent: number;
  pcHpMax: number;
  /** PC speed in ft (for the "30/30" movement display). Defaults to 30 when omitted. */
  pcSpeed?: number;
  /** PC's runtime turnState (only the active actor uses this in the UI). */
  pcTurnState?: TurnState;
  /** PC's runtime position. */
  pcPosition?: Position;
  /** PC's session-level conditions — used to show duration countdowns in combat. */
  pcConditions?: ConditionInstance[];
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
  turnState?: TurnState;
  position?: Position;
  conditions: ConditionInstance[];
}

export function CombatTracker({
  state,
  actors,
  pcCharacterId,
  pcName,
  pcHpCurrent,
  pcHpMax,
  pcSpeed,
  pcTurnState,
  pcPosition,
  pcConditions,
  onEndCombat,
}: CombatTrackerProps) {
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
      return {
        actorId: t.actorId,
        name: pcName,
        init: t.initiative,
        hp: pcHpCurrent,
        hpMax: pcHpMax,
        alive: pcHpCurrent > 0,
        current: idx === state.combat!.currentIdx,
        turnState: pcTurnState ?? undefined,
        position: pcPosition ?? undefined,
        conditions: pcConditions ?? [],
      };
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
      turnState: a?.turnState ?? undefined,
      position: a?.position ?? undefined,
      conditions: a?.conditions ?? [],
    };
  });

  const currentIsPc = order[state.combat.currentIdx]?.actorId === pcCharacterId;
  const activeActor = order[state.combat.currentIdx];
  const activeSpeed = activeActor?.actorId === pcCharacterId ? (pcSpeed ?? 30) : 30;

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
      {activeActor && (
        <ActiveActorPanel
          actor={activeActor}
          speed={activeSpeed}
          actorsById={actorsById(actors, pcCharacterId, pcName)}
        />
      )}
    </section>
  );
}

/**
 * PHB §9.2 — show the active actor's per-turn budget plus position and any
 * condition countdowns. Only the active turn is detailed (the order list
 * above is a high-level recap).
 */
function ActiveActorPanel({
  actor,
  speed,
  actorsById,
}: {
  actor: TurnRow;
  speed: number;
  actorsById: Record<string, string>;
}) {
  const ts = actor.turnState;
  const pos = actor.position;
  const conds = actor.conditions;
  if (!ts && !pos && conds.length === 0) return null;

  const budget = speed * (ts?.dashed ? 2 : 1);
  const spent = ts?.movementSpentFt ?? 0;

  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 10px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <Eyebrow>{actor.name} · this turn</Eyebrow>
      {ts && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <BudgetChip label="Action" used={ts.actionUsed} />
          <BudgetChip label="Bonus" used={ts.bonusUsed} />
          <BudgetChip label="Reaction" used={ts.reactionUsed} />
          <Chip tone={spent >= budget ? 'warn' : 'neutral'}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Move {spent}/{budget} ft</span>
          </Chip>
        </div>
      )}
      {ts && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {ts.dodging && <Chip tone="ok" dot>Dodging</Chip>}
          {ts.disengaged && <Chip tone="ok" dot>Disengaged</Chip>}
          {ts.dashed && <Chip tone="accent" dot>Dashed</Chip>}
          {ts.loadingShotUsed && <Chip tone="warn">Loading shot used</Chip>}
          {ts.offHandAttackUsed && <Chip tone="warn">Off-hand used</Chip>}
          {ts.readied && <Chip tone="gold">Readied: {ts.readied.action}</Chip>}
        </div>
      )}
      {pos && (
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          <span style={{ textTransform: 'capitalize' }}>{pos.band}</span>
          {pos.engagedWith.length > 0 && (
            <>
              {' · Engaged with: '}
              {pos.engagedWith.map((id) => actorsById[id] ?? id).join(', ')}
            </>
          )}
        </div>
      )}
      {conds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {conds.map((c) => (
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
      )}
    </div>
  );
}

function BudgetChip({ label, used }: { label: string; used: boolean }) {
  return (
    <Chip tone={used ? 'warn' : 'ok'} aria-label={`${label} ${used ? 'used' : 'available'}`}>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', marginLeft: 4 }}>{used ? '✓' : '⧗'}</span>
    </Chip>
  );
}

/** Build a name lookup so engagement IDs render as friendly names. */
function actorsById(
  actors: CombatActorRow[],
  pcCharacterId: string,
  pcName: string,
): Record<string, string> {
  const out: Record<string, string> = { [pcCharacterId]: pcName };
  for (const a of actors) out[a.id] = a.name;
  return out;
}
