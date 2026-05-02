'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import { abilityModifier } from '@/engine/modifiers';
import {
  ABILITIES,
  POINT_BUY_BUDGET,
  POINT_BUY_MAX,
  POINT_BUY_MIN,
  POINT_BUY_COST,
  STANDARD_ARRAY,
  type WizardAbilities,
  type AbilityMethod,
} from '@/characters/types';
import type { Ability } from '@/engine/types';
import {
  isCompletePointBuy,
  isCompleteStandardArray,
  pointBuyRemaining,
  pointBuySpent,
  rollSixAbilityValues,
} from '@/characters/abilities-rules';
import { StepHeader } from '../wizard-shell';

export interface AbilitiesStepProps {
  method: AbilityMethod;
  abilities: WizardAbilities;
  onMethodChange: (m: AbilityMethod) => void;
  onAbilitiesChange: (a: WizardAbilities) => void;
}

export function AbilitiesStep({ method, abilities, onMethodChange, onAbilitiesChange }: AbilitiesStepProps) {
  return (
    <div>
      <StepHeader title="Ability scores" sub="Strength carries gold; Dexterity dodges arrows. Pick a method." />
      <MethodPicker
        method={method}
        onChange={(next) => {
          // Snap abilities to a sensible default for the new method.
          if (next === 'array') {
            const fresh: WizardAbilities = {
              STR: STANDARD_ARRAY[0]!,
              DEX: STANDARD_ARRAY[1]!,
              CON: STANDARD_ARRAY[2]!,
              INT: STANDARD_ARRAY[3]!,
              WIS: STANDARD_ARRAY[4]!,
              CHA: STANDARD_ARRAY[5]!,
            };
            onAbilitiesChange(fresh);
          } else if (next === 'pointbuy' && !isCompletePointBuy(abilities)) {
            onAbilitiesChange({ STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 });
          }
          onMethodChange(next);
        }}
      />

      {method === 'array' && (
        <PoolAssign
          pool={STANDARD_ARRAY}
          abilities={abilities}
          onChange={onAbilitiesChange}
          help={`Standard array: ${STANDARD_ARRAY.join(', ')} — assign each value once.`}
          status={
            isCompleteStandardArray(abilities)
              ? { tone: 'ok', text: 'Valid standard array.' }
              : { tone: 'warn', text: 'Each value must be assigned exactly once.' }
          }
        />
      )}

      {method === 'pointbuy' && (
        <PointBuy abilities={abilities} onChange={onAbilitiesChange} />
      )}

      {method === 'roll' && <RollAssign abilities={abilities} onChange={onAbilitiesChange} />}

      <RacialBonusHint />
    </div>
  );
}

// ─── Method picker ──────────────────────────────────────────────────────────────

function MethodPicker({ method, onChange }: { method: AbilityMethod; onChange: (m: AbilityMethod) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
      {(['array', 'pointbuy', 'roll'] as AbilityMethod[]).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          style={{
            padding: '8px 14px',
            borderRadius: 999,
            background: method === id ? 'var(--bone)' : 'var(--bg-card)',
            color: method === id ? 'var(--ink)' : 'var(--fg)',
            border: '1px solid ' + (method === id ? 'var(--bone)' : 'var(--border)'),
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          {id === 'array' ? 'Standard array' : id === 'pointbuy' ? 'Point buy' : 'Roll 4d6 drop lowest'}
        </button>
      ))}
    </div>
  );
}

// ─── Pool-based assignment (used by array + roll) ──────────────────────────────

function PoolAssign({
  pool,
  abilities,
  onChange,
  help,
  status,
}: {
  pool: number[];
  abilities: WizardAbilities;
  onChange: (a: WizardAbilities) => void;
  help: string;
  status: { tone: 'ok' | 'warn'; text: string };
}) {
  const onPick = (target: Ability, newValue: number): void => {
    const previous = abilities[target];
    if (previous === newValue) return;
    // Swap with whichever ability currently holds newValue (preserves the multiset of pool values).
    const swap = ABILITIES.find((a) => a !== target && abilities[a] === newValue);
    if (!swap) {
      onChange({ ...abilities, [target]: newValue });
      return;
    }
    onChange({ ...abilities, [target]: newValue, [swap]: previous });
  };

  return (
    <>
      <Hint text={help} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {ABILITIES.map((k) => {
          const v = abilities[k];
          const mod = abilityModifier(v);
          return (
            <div
              key={k}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 14,
                textAlign: 'center',
              }}
            >
              <Eyebrow>{k}</Eyebrow>
              <select
                value={v}
                onChange={(e) => onPick(k, parseInt(e.target.value, 10))}
                style={{
                  width: '100%',
                  marginTop: 8,
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'center',
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 28,
                  fontWeight: 600,
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                {pool.map((value, i) => (
                  <option key={`${value}-${i}`} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-muted)' }}>
                {mod >= 0 ? '+' : ''}
                {mod}
              </div>
            </div>
          );
        })}
      </div>
      <StatusLine tone={status.tone} text={status.text} />
    </>
  );
}

// ─── Roll mode = pool-assign with a regenerable pool ───────────────────────────

function RollAssign({ abilities, onChange }: { abilities: WizardAbilities; onChange: (a: WizardAbilities) => void }) {
  // The pool is the multiset of current ability values (so the user can swap them around).
  const pool = React.useMemo(() => Object.values(abilities).slice().sort((a, b) => b - a), [abilities]);

  const reroll = (): void => {
    const values = rollSixAbilityValues();
    onChange({
      STR: values[0]!,
      DEX: values[1]!,
      CON: values[2]!,
      INT: values[3]!,
      WIS: values[4]!,
      CHA: values[5]!,
    });
  };

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 14px',
          marginBottom: 16,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Roll <strong style={{ color: 'var(--fg)' }}>4d6, drop the lowest</strong>, six times. Then assign the results.
        </div>
        <button
          type="button"
          onClick={reroll}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 14px',
            background: 'var(--bone)',
            color: 'var(--ink)',
            border: '1px solid var(--bone)',
            borderRadius: 999,
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Icon name="dice" size={14} /> Roll
        </button>
      </div>
      <PoolAssign
        pool={pool}
        abilities={abilities}
        onChange={onChange}
        help={`Pool rolled: ${pool.join(', ')}.`}
        status={{ tone: 'ok', text: 'Drag values between abilities by picking from each dropdown — Roll again to reroll.' }}
      />
    </>
  );
}

// ─── Point buy ──────────────────────────────────────────────────────────────────

function PointBuy({ abilities, onChange }: { abilities: WizardAbilities; onChange: (a: WizardAbilities) => void }) {
  const remaining = pointBuyRemaining(abilities);
  const spent = pointBuySpent(abilities);

  const inc = (k: Ability): void => {
    const v = abilities[k];
    if (v >= POINT_BUY_MAX) return;
    const cost = (POINT_BUY_COST[v + 1] ?? Infinity) - (POINT_BUY_COST[v] ?? 0);
    if (cost > remaining) return;
    onChange({ ...abilities, [k]: v + 1 });
  };
  const dec = (k: Ability): void => {
    const v = abilities[k];
    if (v <= POINT_BUY_MIN) return;
    onChange({ ...abilities, [k]: v - 1 });
  };

  const status = isCompletePointBuy(abilities)
    ? { tone: 'ok' as const, text: 'All 27 points spent — ready to continue.' }
    : remaining < 0
      ? { tone: 'warn' as const, text: `Over budget by ${-remaining}.` }
      : { tone: 'warn' as const, text: `${remaining} points remaining — spend them all to continue.` };

  return (
    <>
      <Hint
        text={`Spend ${POINT_BUY_BUDGET} points across the six abilities. Each starts at ${POINT_BUY_MIN}; max is ${POINT_BUY_MAX}. Costs above 13 are non-linear.`}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          marginBottom: 16,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
        }}
      >
        <span style={{ color: 'var(--fg-muted)' }}>Spent</span>
        <strong style={{ color: 'var(--fg)' }}>{spent === Infinity ? '—' : spent}</strong>
        <span style={{ color: 'var(--fg-subtle)' }}>/ {POINT_BUY_BUDGET}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--fg-muted)' }}>Remaining</span>
        <strong style={{ color: remaining < 0 ? 'var(--ember)' : remaining === 0 ? 'var(--verdigris)' : 'var(--gold)' }}>
          {remaining}
        </strong>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {ABILITIES.map((k) => {
          const v = abilities[k];
          const mod = abilityModifier(v);
          const incCost = v < POINT_BUY_MAX ? (POINT_BUY_COST[v + 1] ?? Infinity) - (POINT_BUY_COST[v] ?? 0) : null;
          const incDisabled = incCost === null || incCost > remaining;
          const decDisabled = v <= POINT_BUY_MIN;
          return (
            <div
              key={k}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 12,
                textAlign: 'center',
              }}
            >
              <Eyebrow>{k}</Eyebrow>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 32, fontWeight: 600, marginTop: 8 }}>{v}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)' }}>
                {mod >= 0 ? '+' : ''}
                {mod}
              </div>
              <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 10 }}>
                <Stepper label="−" onClick={() => dec(k)} disabled={decDisabled} />
                <Stepper
                  label="+"
                  onClick={() => inc(k)}
                  disabled={incDisabled}
                  hint={incCost !== null && !incDisabled ? `${incCost}p` : undefined}
                />
              </div>
            </div>
          );
        })}
      </div>
      <StatusLine tone={status.tone} text={status.text} />
    </>
  );
}

function Stepper({ label, onClick, disabled, hint }: { label: string; onClick: () => void; disabled?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      style={{
        width: 32,
        height: 28,
        borderRadius: 6,
        background: disabled ? 'transparent' : 'var(--bg-elev)',
        border: '1px solid ' + (disabled ? 'var(--border)' : 'var(--border-strong)'),
        color: disabled ? 'var(--fg-subtle)' : 'var(--fg)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────────

function Hint({ text }: { text: string }) {
  return (
    <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
      {text}
    </div>
  );
}

function StatusLine({ tone, text }: { tone: 'ok' | 'warn'; text: string }) {
  const color = tone === 'ok' ? 'var(--verdigris)' : 'var(--gold)';
  return (
    <div style={{ marginTop: 12, fontSize: 12, color, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
      {text}
    </div>
  );
}

function RacialBonusHint() {
  return (
    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-subtle)', textAlign: 'right' }}>
      Racial bonuses are applied next.
    </div>
  );
}
