import { describe, it, expect } from 'vitest';
import {
  evaluateDecommissionReadiness,
  LEGACY_TABLES_TO_DROP,
  LEGACY_TABLES_RETAINED,
  type CampaignDecommissionSnapshot,
} from '../../scripts/decommission-legacy-state';

/**
 * Phase 03 Step 11 (deferred) — guarded legacy-state decommission.
 *
 * The DROP is destructive and irreversible, so the GO/NO-GO decision is a PURE
 * function gated on hard preconditions. These tests exercise that evaluator
 * WITHOUT a DB — the imperative DROP shell is a thin wrapper that only runs
 * when `ready === true`.
 *
 * Contract (all must hold for `ready: true`):
 *   1. `--confirm` was passed (no accidental run).
 *   2. At least one campaign exists (never drop on an empty/misconfigured read).
 *   3. EVERY non-deleted campaign is sourceOfTruth='vault' (nothing still reads PG).
 *   4. NO campaign still has dualWrite=on (coexistence has ended).
 *   5. EVERY vault campaign's rollback window (cutoverAt + windowDays) has elapsed.
 *
 * `characters` is NEVER dropped here — it has inbound FKs (sessions,
 * session_messages) and is still read by the Phase 09 monster-turn resolver
 * (PC AC bridge). Only the two leaf tables go.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_900_000_000_000; // fixed epoch for deterministic window math

function vaultCampaign(over: Partial<CampaignDecommissionSnapshot> = {}): CampaignDecommissionSnapshot {
  return {
    id: 'c-1',
    name: 'One Piece',
    sourceOfTruth: 'vault',
    dualWrite: false,
    cutoverAt: new Date(NOW - 31 * DAY_MS).toISOString(), // 31 days ago → past 30d window
    ...over,
  };
}

describe('LEGACY_TABLES constants — characters is protected', () => {
  it('drops ONLY the two leaf tables, never characters', () => {
    // Spread the `as const` readonly tuple to a plain array for the value compare.
    expect([...LEGACY_TABLES_TO_DROP]).toEqual(['session_state', 'combat_actors']);
    expect([...LEGACY_TABLES_TO_DROP]).not.toContain('characters');
    expect([...LEGACY_TABLES_RETAINED]).toContain('characters');
  });
});

describe('evaluateDecommissionReadiness — GO path', () => {
  it('ready when all campaigns are vault, dualWrite off, window elapsed, and --confirm', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign(), vaultCampaign({ id: 'c-2', name: 'Curse of Strahd' })],
      now: NOW,
      windowDays: 30,
      confirm: true,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.tablesToDrop).toEqual(['session_state', 'combat_actors']);
  });
});

describe('evaluateDecommissionReadiness — NO-GO gates', () => {
  it('blocks without --confirm', () => {
    const r = evaluateDecommissionReadiness({ campaigns: [vaultCampaign()], now: NOW, windowDays: 30, confirm: false });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/--confirm/);
    expect(r.tablesToDrop).toEqual([]); // never expose tables when not ready
  });

  it('blocks on an empty campaign set (misconfigured / empty DB read)', () => {
    const r = evaluateDecommissionReadiness({ campaigns: [], now: NOW, windowDays: 30, confirm: true });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/no campaigns/i);
  });

  it('blocks when a campaign is still sourceOfTruth=postgres', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign(), vaultCampaign({ id: 'c-pg', name: 'Legacy', sourceOfTruth: 'postgres' })],
      now: NOW, windowDays: 30, confirm: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/c-pg.*postgres|postgres.*c-pg|Legacy/i);
  });

  it('blocks when a campaign still has dualWrite on (coexistence not ended)', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign({ dualWrite: true })],
      now: NOW, windowDays: 30, confirm: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/dualWrite|dual-write/i);
  });

  it('blocks when a vault campaign has no cutoverAt timestamp', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign({ cutoverAt: null })],
      now: NOW, windowDays: 30, confirm: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/cutoverAt|window/i);
  });

  it('blocks when the rollback window has NOT elapsed (cutover too recent)', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign({ cutoverAt: new Date(NOW - 10 * DAY_MS).toISOString() })], // 10d < 30d
      now: NOW, windowDays: 30, confirm: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/window|elapsed|days/i);
  });

  it('accumulates multiple blockers rather than failing on the first', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign({ id: 'c-pg', sourceOfTruth: 'postgres', dualWrite: true })],
      now: NOW, windowDays: 30, confirm: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.length).toBeGreaterThanOrEqual(3); // --confirm + postgres + dualWrite
  });

  it('respects a custom windowDays (7-day window, cutover 10 days ago → ready)', () => {
    const r = evaluateDecommissionReadiness({
      campaigns: [vaultCampaign({ cutoverAt: new Date(NOW - 10 * DAY_MS).toISOString() })],
      now: NOW, windowDays: 7, confirm: true,
    });
    expect(r.ready).toBe(true);
  });
});
