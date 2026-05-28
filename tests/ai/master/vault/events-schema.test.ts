import { describe, it, expect } from 'vitest';
import {
  validateEvent,
  isVaultEventType,
  VAULT_EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
} from '@/ai/master/vault/events-schema';

/**
 * Plan 02-01 / Task 2 — tests for the event schema discriminated union +
 * runtime guard.
 *
 * Coverage map (mirrors the acceptance criteria in
 * .planning/phases/02-vault-write-path-event-sourcing/plans/02-01-events-schema.md):
 *
 *   - 1× describe for `VAULT_EVENT_TYPES + isVaultEventType` (1 listing
 *     case + 1 narrowing case with 4 subassertions).
 *   - 1× describe for happy-path validation (one `it` per event type,
 *     with `campaign_initialized` carrying THREE variants — minimum /
 *     hp_current present / full shape — reflecting the Postgres schema
 *     reality from Decision 9).
 *   - 1× describe for rejection cases (one `it` per failure class
 *     enumerated in the plan).
 *   - 1× describe for `VaultEventEnvelope` shape (version constant
 *     literal-type narrowing).
 *
 * The file imports ONLY from `@/ai/master/vault/events-schema`, which has
 * zero imports — so the test runs without `DATABASE_URL`.
 */
describe('events-schema', () => {
  describe('VAULT_EVENT_TYPES + isVaultEventType', () => {
    it('lists exactly the 34 known event types (8 Phase 02 + 20 Phase 03 + 6 Phase 06 D1)', () => {
      expect(VAULT_EVENT_TYPES).toHaveLength(34);
      expect(new Set(VAULT_EVENT_TYPES)).toEqual(
        new Set([
          // Phase 02 (unchanged)
          'hp_change',
          'condition_add',
          'condition_remove',
          'spell_slot_use',
          'spell_slot_restore',
          'inventory_add',
          'inventory_remove',
          'campaign_initialized',
          // Phase 03 (from COMPLETENESS-AUDIT.md §"(c) Final list")
          'temp_hp_set',
          'death_save_success',
          'death_save_fail',
          'death_save_stabilize',
          'death_save_recover_at_one',
          'concentration_set',
          'concentration_break',
          'exhaustion_increment',
          'exhaustion_decrement',
          'hit_dice_use',
          'hit_dice_restore',
          'resource_use',
          'resource_restore',
          'inspiration_grant',
          'inspiration_spend',
          'attune',
          'unattune',
          'focus_set',
          'focus_unset',
          'xp_award',
          // Phase 06 D1 (encounter-scoped — no payload.character)
          'combat_start',
          'monster_spawn',
          'initiative_set',
          'turn_advance',
          'monster_hp_change',
          'combat_end',
        ]),
      );
    });

    it('preserves all 8 Phase 02 event types in their original positions (compat assertion)', () => {
      // Phase 02 ordering is load-bearing for `phase-smoke` tests (see
      // events-schema.ts JSDoc). The first 8 entries MUST stay in this
      // exact order — Phase 03 additions are appended.
      expect(VAULT_EVENT_TYPES.slice(0, 8)).toEqual([
        'hp_change',
        'condition_add',
        'condition_remove',
        'spell_slot_use',
        'spell_slot_restore',
        'inventory_add',
        'inventory_remove',
        'campaign_initialized',
      ]);
    });

    it('isVaultEventType narrows known types and rejects unknown/non-string', () => {
      expect(isVaultEventType('hp_change')).toBe(true);
      expect(isVaultEventType('campaign_initialized')).toBe(true);
      expect(isVaultEventType('unknown')).toBe(false);
      expect(isVaultEventType('')).toBe(false);
      expect(isVaultEventType(123)).toBe(false);
      expect(isVaultEventType(null)).toBe(false);
      expect(isVaultEventType(undefined)).toBe(false);
      expect(isVaultEventType({})).toBe(false);
    });

    it('isVaultEventType returns true for every Phase 03 addition', () => {
      const phase03Types = [
        'temp_hp_set',
        'death_save_success',
        'death_save_fail',
        'death_save_stabilize',
        'death_save_recover_at_one',
        'concentration_set',
        'concentration_break',
        'exhaustion_increment',
        'exhaustion_decrement',
        'hit_dice_use',
        'hit_dice_restore',
        'resource_use',
        'resource_restore',
        'inspiration_grant',
        'inspiration_spend',
        'attune',
        'unattune',
        'focus_set',
        'focus_unset',
        'xp_award',
      ];
      for (const t of phase03Types) {
        expect(isVaultEventType(t)).toBe(true);
      }
    });
  });

  describe('validateEvent — happy paths', () => {
    it('accepts hp_change with negative delta', () => {
      const r = validateEvent({ type: 'hp_change', payload: { character: 'aragorn', delta: -5 } });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('hp_change');
        expect(r.value.payload).toEqual({ character: 'aragorn', delta: -5 });
      }
    });

    it('accepts hp_change with positive delta', () => {
      const r = validateEvent({ type: 'hp_change', payload: { character: 'gandalf', delta: 7 } });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('hp_change');
        expect(r.value.payload).toEqual({ character: 'gandalf', delta: 7 });
      }
    });

    it('accepts condition_add', () => {
      const r = validateEvent({
        type: 'condition_add',
        payload: { character: 'aragorn', condition: 'frightened' },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('condition_add');
        expect(r.value.payload).toEqual({ character: 'aragorn', condition: 'frightened' });
      }
    });

    it('accepts condition_remove', () => {
      const r = validateEvent({
        type: 'condition_remove',
        payload: { character: 'aragorn', condition: 'frightened' },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('condition_remove');
        expect(r.value.payload).toEqual({ character: 'aragorn', condition: 'frightened' });
      }
    });

    it('accepts spell_slot_use at every valid level (1..9)', () => {
      for (let level = 1; level <= 9; level++) {
        const r = validateEvent({
          type: 'spell_slot_use',
          payload: { character: 'gandalf', level },
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.type).toBe('spell_slot_use');
          expect(r.value.payload).toEqual({ character: 'gandalf', level });
        }
      }
    });

    it('accepts spell_slot_restore at level 1 (lower bound)', () => {
      const r = validateEvent({
        type: 'spell_slot_restore',
        payload: { character: 'gandalf', level: 1 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('spell_slot_restore');
        expect(r.value.payload).toEqual({ character: 'gandalf', level: 1 });
      }
    });

    it('accepts inventory_add with qty = 1 (lower bound)', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: 'rope', qty: 1 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('inventory_add');
        expect(r.value.payload).toEqual({ character: 'aragorn', item: 'rope', qty: 1 });
      }
    });

    it('accepts inventory_add with qty = 999 (upper bound)', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: 'arrow', qty: 999 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.payload).toEqual({ character: 'aragorn', item: 'arrow', qty: 999 });
      }
    });

    it('accepts inventory_remove', () => {
      const r = validateEvent({
        type: 'inventory_remove',
        payload: { character: 'aragorn', item: 'torch', qty: 2 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.type).toBe('inventory_remove');
        expect(r.value.payload).toEqual({ character: 'aragorn', item: 'torch', qty: 2 });
      }
    });

    it('accepts campaign_initialized minimum (hp_current + spell_slots absent — fresh campaign, no session_state row)', () => {
      // Mirrors the Decision 9 fresh-campaign case: the flip script reads
      // `characters.hpMax` but finds no `session_state` row (no played
      // session yet), and the PC is a non-caster (`spellcasting: null`).
      // Both optional fields are absent; the projector defaults them.
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', name: 'A', hp_max: 10 }] },
      });
      expect(r.ok).toBe(true);
      if (r.ok && r.value.type === 'campaign_initialized') {
        expect(r.value.type).toBe('campaign_initialized');
        expect(r.value.payload.characters).toEqual([{ id: 'uuid1', name: 'A', hp_max: 10 }]);
      }
    });

    it('accepts campaign_initialized with hp_current present and in-range', () => {
      // session_state.hpCurrent is present for the most-recent active session.
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', name: 'A', hp_max: 10, hp_current: 7 }] },
      });
      expect(r.ok).toBe(true);
      if (r.ok && r.value.type === 'campaign_initialized') {
        expect(r.value.payload.characters[0]).toEqual({
          id: 'uuid1',
          name: 'A',
          hp_max: 10,
          hp_current: 7,
        });
      }
    });

    it('accepts campaign_initialized full shape (matches active wizard PC after the flip)', () => {
      // What the flip script (plan 02-10 Task 4) produces for an active
      // wizard PC: hpCurrent from session_state, slotsMax merged with
      // spellSlotsUsed.
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: {
          characters: [
            {
              id: 'uuid1',
              name: 'A',
              hp_max: 10,
              hp_current: 7,
              spell_slots: {
                '1': { max: 4, used: 2 },
                '2': { max: 2, used: 0 },
              },
            },
          ],
        },
      });
      expect(r.ok).toBe(true);
      if (r.ok && r.value.type === 'campaign_initialized') {
        const first = r.value.payload.characters[0];
        expect(first).toBeDefined();
        if (first) {
          expect(first.hp_current).toBe(7);
          expect(first.spell_slots).toEqual({
            '1': { max: 4, used: 2 },
            '2': { max: 2, used: 0 },
          });
        }
      }
    });

    it('accepts campaign_initialized with empty characters array', () => {
      // Edge case: a campaign with no PCs (e.g. created but never opened).
      // The flip script still emits a valid seed; the projector starts
      // with an empty state.
      const r = validateEvent({ type: 'campaign_initialized', payload: { characters: [] } });
      expect(r.ok).toBe(true);
      if (r.ok && r.value.type === 'campaign_initialized') {
        expect(r.value.payload.characters).toEqual([]);
      }
    });
  });

  describe('validateEvent — rejection cases', () => {
    it('rejects unknown event type with helpful error', () => {
      const r = validateEvent({ type: 'level_up', payload: {} });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/unknown event type/i);
        expect(r.error).toContain('level_up');
      }
    });

    it('rejects hp_change with missing delta', () => {
      const r = validateEvent({ type: 'hp_change', payload: { character: 'aragorn' } });
      expect(r.ok).toBe(false);
    });

    it('rejects hp_change with string delta (wrong type)', () => {
      const r = validateEvent({
        type: 'hp_change',
        payload: { character: 'aragorn', delta: '5' },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects hp_change with empty character name', () => {
      const r = validateEvent({ type: 'hp_change', payload: { character: '', delta: 5 } });
      expect(r.ok).toBe(false);
    });

    it('rejects hp_change with NaN delta', () => {
      const r = validateEvent({
        type: 'hp_change',
        payload: { character: 'aragorn', delta: NaN },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects hp_change with Infinity delta', () => {
      const r = validateEvent({
        type: 'hp_change',
        payload: { character: 'aragorn', delta: Infinity },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects hp_change with -Infinity delta', () => {
      const r = validateEvent({
        type: 'hp_change',
        payload: { character: 'aragorn', delta: -Infinity },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects condition_add with empty condition', () => {
      const r = validateEvent({
        type: 'condition_add',
        payload: { character: 'aragorn', condition: '' },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects spell_slot_use with level > 9', () => {
      const r = validateEvent({
        type: 'spell_slot_use',
        payload: { character: 'aragorn', level: 10 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects spell_slot_use with level < 1', () => {
      const r = validateEvent({
        type: 'spell_slot_use',
        payload: { character: 'aragorn', level: 0 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects spell_slot_use with non-integer level', () => {
      const r = validateEvent({
        type: 'spell_slot_use',
        payload: { character: 'aragorn', level: 2.5 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects spell_slot_restore with negative level', () => {
      const r = validateEvent({
        type: 'spell_slot_restore',
        payload: { character: 'aragorn', level: -3 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects inventory_add with qty = 0', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: 'rope', qty: 0 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects inventory_add with negative qty', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: 'rope', qty: -1 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects inventory_add with qty = 1000 (upper bound is exclusive)', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: 'rope', qty: 1000 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects inventory_add with empty item string', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: '', qty: 5 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects inventory_add with non-integer qty', () => {
      const r = validateEvent({
        type: 'inventory_add',
        payload: { character: 'aragorn', item: 'rope', qty: 2.7 },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized with non-array characters', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: 'foo' },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when characters entry is missing hp_max', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', name: 'A' }] },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when characters entry is missing id', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ name: 'A', hp_max: 10 }] },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when characters entry is missing name', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', hp_max: 10 }] },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when characters entry has empty name string', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', name: '', hp_max: 10 }] },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when hp_max is non-positive', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', name: 'A', hp_max: 0 }] },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when hp_max is non-integer', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: { characters: [{ id: 'uuid1', name: 'A', hp_max: 10.5 }] },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when hp_current > hp_max', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: {
          characters: [{ id: 'uuid1', name: 'A', hp_max: 10, hp_current: 11 }],
        },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized when hp_current is negative', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: {
          characters: [{ id: 'uuid1', name: 'A', hp_max: 10, hp_current: -1 }],
        },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized spell_slots entry with used > max', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: {
          characters: [
            { id: 'uuid1', name: 'A', hp_max: 10, spell_slots: { '1': { max: 2, used: 5 } } },
          ],
        },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized spell_slots as array (must be a non-array object)', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: {
          characters: [{ id: 'uuid1', name: 'A', hp_max: 10, spell_slots: [] as never }],
        },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects campaign_initialized spell_slots entry with negative max', () => {
      const r = validateEvent({
        type: 'campaign_initialized',
        payload: {
          characters: [
            { id: 'uuid1', name: 'A', hp_max: 10, spell_slots: { '1': { max: -1, used: 0 } } },
          ],
        },
      });
      expect(r.ok).toBe(false);
    });

    it('rejects payload that is not an object (string)', () => {
      const r = validateEvent({ type: 'hp_change', payload: 'not an object' });
      expect(r.ok).toBe(false);
    });

    it('rejects payload that is null', () => {
      const r = validateEvent({ type: 'hp_change', payload: null });
      expect(r.ok).toBe(false);
    });

    it('rejects payload that is an array', () => {
      const r = validateEvent({ type: 'hp_change', payload: ['character', 'aragorn'] });
      expect(r.ok).toBe(false);
    });

    it('rejects payload that is a number', () => {
      const r = validateEvent({ type: 'hp_change', payload: 42 });
      expect(r.ok).toBe(false);
    });

    it('rejects non-string type field', () => {
      const r = validateEvent({ type: 123 as unknown as string, payload: {} });
      expect(r.ok).toBe(false);
    });
  });

  describe('VaultEventEnvelope shape', () => {
    it('EVENT_SCHEMA_VERSION equals 1 and preserves literal-type narrowing', () => {
      expect(EVENT_SCHEMA_VERSION).toBe(1);
      // Literal-type assertion: assigning the literal `1` to a binding
      // typed `typeof EVENT_SCHEMA_VERSION` only typechecks if the
      // constant is still `as const` (otherwise it widens to `number`
      // and the assignment from any number would be allowed).
      const v: typeof EVENT_SCHEMA_VERSION = 1;
      expect(v).toBe(1);
    });

    it('EVENT_SCHEMA_VERSION is unchanged at 1 after Phase 03 additions', () => {
      // Phase 03 additions are ADDITIVE — new union members + validator
      // arms, no breaking payload-shape changes to Phase 02 types. The
      // version bump convention is for INCOMPATIBLE payload changes
      // (e.g., adding a required field to an existing event type).
      // Sanity assertion to surface accidental version bumps in code review.
      expect(EVENT_SCHEMA_VERSION).toBe(1);
    });
  });

  // =======================================================================
  // Phase 03 additions — happy + reject cases per new event type. See
  // .planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md
  // §"(c) Detailed event-type specifications" for the authoritative payload
  // + validator rules each describe block exercises.
  // =======================================================================
  describe('validateEvent — Phase 03 additions', () => {
    describe('temp_hp_set', () => {
      it('accepts valid payload with positive tempHp', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { character: 'char-1', tempHp: 5 },
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value).toEqual({
            type: 'temp_hp_set',
            payload: { character: 'char-1', tempHp: 5 },
          });
        }
      });

      it('accepts tempHp = 0 (long-rest reset)', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { character: 'char-1', tempHp: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects negative tempHp', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { character: 'char-1', tempHp: -1 },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/tempHp/i);
      });

      it('rejects tempHp >= 1000 (T-02-03 payload-size mitigation)', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { character: 'char-1', tempHp: 1000 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-integer tempHp', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { character: 'char-1', tempHp: 5.5 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing character', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { tempHp: 5 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-numeric tempHp', () => {
        const r = validateEvent({
          type: 'temp_hp_set',
          payload: { character: 'c', tempHp: 'five' as unknown as number },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('death_save_success', () => {
      it('accepts valid payload', () => {
        const r = validateEvent({
          type: 'death_save_success',
          payload: { character: 'char-1' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects empty character', () => {
        const r = validateEvent({
          type: 'death_save_success',
          payload: { character: '' },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing character', () => {
        const r = validateEvent({
          type: 'death_save_success',
          payload: {},
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('death_save_fail', () => {
      it('accepts valid payload without critical (regular failure)', () => {
        const r = validateEvent({
          type: 'death_save_fail',
          payload: { character: 'char-1' },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'death_save_fail') {
          expect(r.value.payload).toEqual({ character: 'char-1' });
        }
      });

      it('accepts valid payload with critical: true (nat-1 counts as 2 failures)', () => {
        const r = validateEvent({
          type: 'death_save_fail',
          payload: { character: 'char-1', critical: true },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'death_save_fail') {
          expect(r.value.payload).toEqual({ character: 'char-1', critical: true });
        }
      });

      it('accepts valid payload with critical: false (explicit non-critical)', () => {
        const r = validateEvent({
          type: 'death_save_fail',
          payload: { character: 'char-1', critical: false },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'death_save_fail') {
          expect(r.value.payload).toEqual({ character: 'char-1', critical: false });
        }
      });

      it('rejects non-boolean critical', () => {
        const r = validateEvent({
          type: 'death_save_fail',
          payload: { character: 'c', critical: 'yes' as unknown as boolean },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing character', () => {
        const r = validateEvent({
          type: 'death_save_fail',
          payload: { critical: true },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('death_save_stabilize', () => {
      it('accepts valid payload', () => {
        const r = validateEvent({
          type: 'death_save_stabilize',
          payload: { character: 'char-1' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects empty character', () => {
        const r = validateEvent({
          type: 'death_save_stabilize',
          payload: { character: '' },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('death_save_recover_at_one', () => {
      it('accepts valid payload (PHB §3.18 nat-20 atomic recovery)', () => {
        const r = validateEvent({
          type: 'death_save_recover_at_one',
          payload: { character: 'char-1' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects empty character', () => {
        const r = validateEvent({
          type: 'death_save_recover_at_one',
          payload: { character: '' },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-string character', () => {
        const r = validateEvent({
          type: 'death_save_recover_at_one',
          payload: { character: 42 as unknown as string },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('concentration_set', () => {
      it('accepts valid payload with slotLevel 1 (1st-level spell)', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'bless', slotLevel: 1, startedRound: 3 },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'concentration_set') {
          expect(r.value.payload).toEqual({
            character: 'c',
            spellSlug: 'bless',
            slotLevel: 1,
            startedRound: 3,
          });
        }
      });

      it('accepts slotLevel 0 (cantrip concentration — Spike Growth-like)', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'wisp', slotLevel: 0, startedRound: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts slotLevel 9 (upper bound — Wish, Foresight)', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'foresight', slotLevel: 9, startedRound: 1 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects slotLevel 10 (out of range)', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'wish', slotLevel: 10, startedRound: 1 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects negative slotLevel', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'bless', slotLevel: -1, startedRound: 1 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects negative startedRound', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'bless', slotLevel: 1, startedRound: -1 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-integer startedRound', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: 'bless', slotLevel: 1, startedRound: 1.5 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects empty spellSlug', () => {
        const r = validateEvent({
          type: 'concentration_set',
          payload: { character: 'c', spellSlug: '', slotLevel: 1, startedRound: 0 },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('concentration_break', () => {
      it('accepts reason: damage', () => {
        const r = validateEvent({
          type: 'concentration_break',
          payload: { character: 'c', reason: 'damage' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts reason: killed', () => {
        const r = validateEvent({
          type: 'concentration_break',
          payload: { character: 'c', reason: 'killed' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts reason: incapacitated', () => {
        const r = validateEvent({
          type: 'concentration_break',
          payload: { character: 'c', reason: 'incapacitated' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects unknown reason', () => {
        const r = validateEvent({
          type: 'concentration_break',
          payload: { character: 'c', reason: 'fell-asleep' as unknown as 'damage' },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing reason', () => {
        const r = validateEvent({
          type: 'concentration_break',
          payload: { character: 'c' },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('exhaustion_increment', () => {
      it('accepts source: forced_march', () => {
        const r = validateEvent({
          type: 'exhaustion_increment',
          payload: { character: 'c', source: 'forced_march' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts source: starvation', () => {
        const r = validateEvent({
          type: 'exhaustion_increment',
          payload: { character: 'c', source: 'starvation' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts source: dehydration', () => {
        const r = validateEvent({
          type: 'exhaustion_increment',
          payload: { character: 'c', source: 'dehydration' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts arbitrary non-empty source string (validator is loose per audit)', () => {
        // Audit §"exhaustion_increment" validator rule: source must be a
        // non-empty string. The audit lists conventional values (forced_march,
        // starvation, dehydration, magical, other) but does not restrict the
        // validator to that enum.
        const r = validateEvent({
          type: 'exhaustion_increment',
          payload: { character: 'c', source: 'magical' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects empty source', () => {
        const r = validateEvent({
          type: 'exhaustion_increment',
          payload: { character: 'c', source: '' },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing source', () => {
        const r = validateEvent({
          type: 'exhaustion_increment',
          payload: { character: 'c' },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('exhaustion_decrement', () => {
      it('accepts valid payload', () => {
        const r = validateEvent({
          type: 'exhaustion_decrement',
          payload: { character: 'c' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects empty character', () => {
        const r = validateEvent({
          type: 'exhaustion_decrement',
          payload: { character: '' },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe.each(['hit_dice_use', 'hit_dice_restore'] as const)('%s', (type) => {
      it('accepts count = 1 (lower bound)', () => {
        const r = validateEvent({ type, payload: { character: 'c', count: 1 } });
        expect(r.ok).toBe(true);
      });

      it('accepts count = 20 (upper bound)', () => {
        const r = validateEvent({ type, payload: { character: 'c', count: 20 } });
        expect(r.ok).toBe(true);
      });

      it('rejects count = 0', () => {
        const r = validateEvent({ type, payload: { character: 'c', count: 0 } });
        expect(r.ok).toBe(false);
      });

      it('rejects count = 21 (out of range)', () => {
        const r = validateEvent({ type, payload: { character: 'c', count: 21 } });
        expect(r.ok).toBe(false);
      });

      it('rejects non-integer count', () => {
        const r = validateEvent({ type, payload: { character: 'c', count: 2.5 } });
        expect(r.ok).toBe(false);
      });

      it('rejects missing count', () => {
        const r = validateEvent({ type, payload: { character: 'c' } });
        expect(r.ok).toBe(false);
      });
    });

    describe.each(['resource_use', 'resource_restore'] as const)('%s', (type) => {
      it('accepts valid payload (uses = 1)', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', resourceKey: 'rage', uses: 1 },
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.payload).toEqual({
            character: 'c',
            resourceKey: 'rage',
            uses: 1,
          });
        }
      });

      it('accepts uses = 50 (upper bound — T-02-03 payload-size mitigation)', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', resourceKey: 'channel_divinity', uses: 50 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects uses = 0', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', resourceKey: 'rage', uses: 0 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects uses > 50', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', resourceKey: 'rage', uses: 51 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-integer uses', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', resourceKey: 'k', uses: 1.5 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects empty resourceKey', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', resourceKey: '', uses: 1 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing resourceKey', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', uses: 1 },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe.each(['inspiration_grant', 'inspiration_spend'] as const)('%s', (type) => {
      it('accepts valid payload', () => {
        const r = validateEvent({ type, payload: { character: 'c' } });
        expect(r.ok).toBe(true);
      });

      it('rejects empty character', () => {
        const r = validateEvent({ type, payload: { character: '' } });
        expect(r.ok).toBe(false);
      });
    });

    describe.each(['attune', 'unattune'] as const)('%s', (type) => {
      it('accepts valid payload', () => {
        const r = validateEvent({
          type,
          payload: { character: 'c', itemSlug: 'ring-of-protection' },
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.payload).toEqual({
            character: 'c',
            itemSlug: 'ring-of-protection',
          });
        }
      });

      it('accepts itemSlug at upper length bound (64 chars)', () => {
        const slug = 'a'.repeat(64);
        const r = validateEvent({ type, payload: { character: 'c', itemSlug: slug } });
        expect(r.ok).toBe(true);
      });

      it('rejects itemSlug > 64 chars', () => {
        const slug = 'a'.repeat(65);
        const r = validateEvent({ type, payload: { character: 'c', itemSlug: slug } });
        expect(r.ok).toBe(false);
      });

      it('rejects empty itemSlug', () => {
        const r = validateEvent({ type, payload: { character: 'c', itemSlug: '' } });
        expect(r.ok).toBe(false);
      });

      it('rejects missing itemSlug', () => {
        const r = validateEvent({ type, payload: { character: 'c' } });
        expect(r.ok).toBe(false);
      });
    });

    describe('focus_set', () => {
      it('accepts kind: arcane', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: { character: 'c', kind: 'arcane', itemSlug: 'wand-of-the-war-mage' },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'focus_set') {
          expect(r.value.payload).toEqual({
            character: 'c',
            kind: 'arcane',
            itemSlug: 'wand-of-the-war-mage',
          });
        }
      });

      it('accepts kind: druidic', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: { character: 'c', kind: 'druidic', itemSlug: 'sprig-of-mistletoe' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts kind: holy', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: { character: 'c', kind: 'holy', itemSlug: 'amulet-of-the-devout' },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts kind: instrument', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: { character: 'c', kind: 'instrument', itemSlug: 'lute' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects unknown kind', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: {
            character: 'c',
            kind: 'psychic' as unknown as 'arcane',
            itemSlug: 'crystal',
          },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects empty itemSlug', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: { character: 'c', kind: 'arcane', itemSlug: '' },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects missing kind', () => {
        const r = validateEvent({
          type: 'focus_set',
          payload: { character: 'c', itemSlug: 'wand' },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('focus_unset', () => {
      it('accepts valid payload', () => {
        const r = validateEvent({
          type: 'focus_unset',
          payload: { character: 'c' },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects empty character', () => {
        const r = validateEvent({
          type: 'focus_unset',
          payload: { character: '' },
        });
        expect(r.ok).toBe(false);
      });
    });

    describe('xp_award', () => {
      it('accepts valid payload without reason', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 250 },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'xp_award') {
          expect(r.value.payload).toEqual({ character: 'c', amount: 250 });
        }
      });

      it('accepts valid payload with reason', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 250, reason: 'defeated owlbear' },
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.value.type === 'xp_award') {
          expect(r.value.payload).toEqual({
            character: 'c',
            amount: 250,
            reason: 'defeated owlbear',
          });
        }
      });

      it('accepts amount = 1 (lower bound)', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 1 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts amount = 999999 (upper-bound, exclusive)', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 999_999 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects amount = 0', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 0 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects negative amount', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: -100 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects amount >= 1_000_000 (upper-bound, exclusive)', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 1_000_000 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-integer amount', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 250.5 },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects reason > 256 chars', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 100, reason: 'x'.repeat(257) },
        });
        expect(r.ok).toBe(false);
      });

      it('rejects non-string reason', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 100, reason: 42 as unknown as string },
        });
        expect(r.ok).toBe(false);
      });

      it('accepts reason at upper length bound (256 chars)', () => {
        const r = validateEvent({
          type: 'xp_award',
          payload: { character: 'c', amount: 100, reason: 'x'.repeat(256) },
        });
        expect(r.ok).toBe(true);
      });
    });

    // ---------------------------------------------------------------------
    // Cross-cutting assertions (each new event type satisfies the
    // shared envelope discipline — non-object payload rejected, character
    // field required).
    // ---------------------------------------------------------------------
    describe('shared rejection patterns', () => {
      const phase03TypesWithDefaultPayload: ReadonlyArray<{
        type: string;
        defaultPayload: Record<string, unknown>;
      }> = [
        { type: 'temp_hp_set', defaultPayload: { character: 'c', tempHp: 1 } },
        { type: 'death_save_success', defaultPayload: { character: 'c' } },
        { type: 'death_save_fail', defaultPayload: { character: 'c' } },
        { type: 'death_save_stabilize', defaultPayload: { character: 'c' } },
        { type: 'death_save_recover_at_one', defaultPayload: { character: 'c' } },
        {
          type: 'concentration_set',
          defaultPayload: { character: 'c', spellSlug: 's', slotLevel: 1, startedRound: 0 },
        },
        {
          type: 'concentration_break',
          defaultPayload: { character: 'c', reason: 'damage' },
        },
        { type: 'exhaustion_increment', defaultPayload: { character: 'c', source: 'magical' } },
        { type: 'exhaustion_decrement', defaultPayload: { character: 'c' } },
        { type: 'hit_dice_use', defaultPayload: { character: 'c', count: 1 } },
        { type: 'hit_dice_restore', defaultPayload: { character: 'c', count: 1 } },
        {
          type: 'resource_use',
          defaultPayload: { character: 'c', resourceKey: 'k', uses: 1 },
        },
        {
          type: 'resource_restore',
          defaultPayload: { character: 'c', resourceKey: 'k', uses: 1 },
        },
        { type: 'inspiration_grant', defaultPayload: { character: 'c' } },
        { type: 'inspiration_spend', defaultPayload: { character: 'c' } },
        { type: 'attune', defaultPayload: { character: 'c', itemSlug: 'i' } },
        { type: 'unattune', defaultPayload: { character: 'c', itemSlug: 'i' } },
        {
          type: 'focus_set',
          defaultPayload: { character: 'c', kind: 'arcane', itemSlug: 'i' },
        },
        { type: 'focus_unset', defaultPayload: { character: 'c' } },
        { type: 'xp_award', defaultPayload: { character: 'c', amount: 1 } },
      ];

      it('every Phase 03 type accepts its happy-path payload', () => {
        for (const { type, defaultPayload } of phase03TypesWithDefaultPayload) {
          const r = validateEvent({ type, payload: defaultPayload });
          expect(r.ok, `expected ${type} to accept its happy payload, got error`).toBe(true);
        }
      });

      it('every Phase 03 type rejects empty character', () => {
        for (const { type, defaultPayload } of phase03TypesWithDefaultPayload) {
          const r = validateEvent({
            type,
            payload: { ...defaultPayload, character: '' },
          });
          expect(r.ok, `expected ${type} to reject empty character`).toBe(false);
        }
      });

      it('every Phase 03 type rejects null payload', () => {
        for (const { type } of phase03TypesWithDefaultPayload) {
          const r = validateEvent({ type, payload: null });
          expect(r.ok, `expected ${type} to reject null payload`).toBe(false);
        }
      });

      it('every Phase 03 type rejects array payload', () => {
        for (const { type } of phase03TypesWithDefaultPayload) {
          const r = validateEvent({ type, payload: [] });
          expect(r.ok, `expected ${type} to reject array payload`).toBe(false);
        }
      });
    });
  });
});
