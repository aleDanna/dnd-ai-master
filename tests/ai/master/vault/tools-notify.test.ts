import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Phase 03 → Phase 04 SSE hand-off (RESEARCH Pitfall 3).
 *
 * The SSE UI-refresh transport (pg_notify on `session_<id>` → the stream
 * route's LISTEN → the client's refetch) is driven by a `{ type: 'state' }`
 * notify. On the LEGACY path that notify is emitted by the Postgres
 * applicator (`applicator.ts`). On the VAULT path, `apply_event` wrote
 * `events.md` and emitted NOTHING — so after the legacy-state drop a vault
 * mutation would never push a UI refresh.
 *
 * Fix: `dispatchVaultTool` emits `notifySession(sessionId, { type: 'state' })`
 * after a SUCCESSFUL `apply_event`, gated on `ctx.sessionId`. This suite
 * asserts that contract against the REAL dispatcher API
 * (`dispatchVaultTool(name, input, ctx)`).
 *
 * The vault write internals (EventsWriter / projector) are mocked so the
 * single-write success path runs without real fs/db; notify is mocked so we
 * assert the call without a live Postgres NOTIFY.
 */

vi.mock('@/sessions/notify', () => ({
  notifySession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/ai/master/vault/events-writer', () => ({
  EventsWriter: { applyEvent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/ai/master/vault/projector', () => ({
  regenerateAffectedViews: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchVaultTool } from '@/ai/master/vault/tools';
import { notifySession } from '@/sessions/notify';

const notifyMock = vi.mocked(notifySession);
const CAMPAIGN = '11111111-2222-3333-4444-555555555555';
const CHAR = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION = 'ssssssss-1111-2222-3333-444444444444';

const hpChange = { type: 'hp_change', payload: { character: CHAR, delta: -3 } };

describe('dispatchVaultTool — SSE state notify on a successful vault apply_event', () => {
  beforeEach(() => notifyMock.mockClear());
  afterEach(() => vi.clearAllMocks());

  it('emits notifySession(sessionId, {type:state}) after a successful single-write apply_event', async () => {
    const r = await dispatchVaultTool('apply_event', hpChange, { campaignId: CAMPAIGN, sessionId: SESSION });
    expect(r.isError).toBe(false);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(SESSION, { type: 'state' });
  });

  it('does NOT notify when sessionId is absent (headless / server-resolver-without-session)', async () => {
    const r = await dispatchVaultTool('apply_event', hpChange, { campaignId: CAMPAIGN });
    expect(r.isError).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does NOT notify when apply_event ERRORED (bad campaignId — nothing was written)', async () => {
    const r = await dispatchVaultTool('apply_event', hpChange, { campaignId: 'not-a-uuid', sessionId: SESSION });
    expect(r.isError).toBe(true);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does NOT notify for a read-only tool (read_vault_multi) even with sessionId', async () => {
    const r = await dispatchVaultTool('read_vault_multi', { paths: ['handbook/x.md'] }, { sessionId: SESSION });
    expect(r.isError).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does NOT notify for end_turn (terminator, not a mutation)', async () => {
    await dispatchVaultTool('end_turn', { response: 'done' }, { sessionId: SESSION });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does NOT throw the turn even if notify rejects (fire-and-forget)', async () => {
    notifyMock.mockRejectedValueOnce(new Error('pg NOTIFY down'));
    const r = await dispatchVaultTool('apply_event', hpChange, { campaignId: CAMPAIGN, sessionId: SESSION });
    expect(r.isError).toBe(false); // the apply still succeeded; notify failure is swallowed
  });
});
