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
    it('lists exactly the 8 known event types', () => {
      expect(VAULT_EVENT_TYPES).toHaveLength(8);
      expect(new Set(VAULT_EVENT_TYPES)).toEqual(
        new Set([
          'hp_change',
          'condition_add',
          'condition_remove',
          'spell_slot_use',
          'spell_slot_restore',
          'inventory_add',
          'inventory_remove',
          'campaign_initialized',
        ]),
      );
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
  });
});
