import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, act } from '@testing-library/react';
import type { Character } from '@/engine/types';
import type {
  CampaignRow,
  MessageRow,
  SessionRow,
  SessionStateRow,
} from '@/sessions/client-types';

// Regression: the campaign-opener ("begin") turn leaves the composer FROZEN on
// "The Master is generating the campaign…" until a manual page refresh.
//
// Root cause: the begin auto-fire optimistically sets turnStatus.isBegin, which
// feeds `busy` (and therefore `composerDisabled`). turnStatus is normally cleared
// by an SSE message-chunk/message/turn-error event. When that completion SSE is
// DROPPED (the documented vault-path NOTIFY drop the safety poll exists for), the
// opener is recovered by the HTTP safety poll — but the poll historically cleared
// streamingMessage + pendingTurn and NOT turnStatus, so `busy` stayed true and the
// input stayed disabled forever. This test drives exactly that path: begin fires,
// no SSE is delivered, the safety poll recovers the opener, and the composer must
// become ENABLED without a remount.

// Expose the `disabled` prop so the test can assert the composer lock state.
vi.mock('@/components/game/narrative-pane', () => ({
  NarrativePane: (props: { disabled?: boolean; busyLabel?: string }) => (
    <div
      data-testid="composer"
      data-disabled={String(!!props.disabled)}
      data-label={props.busyLabel ?? ''}
    />
  ),
}));
vi.mock('@/components/game/character-pane', () => ({ CharacterPane: () => null }));
vi.mock('@/components/game/autoplay-toggle', () => ({ AutoplayToggle: () => null }));
// Memory ready immediately → the begin auto-fire is allowed to run. Signal via
// an effect (not during render) to avoid the setState-in-render warning.
vi.mock('@/components/memory-status-banner', () => ({
  MemoryStatusBanner: (props: { onReady: () => void }) => {
    React.useEffect(() => { props.onReady(); }, [props]);
    return null;
  },
}));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: unknown }) => <a href={props.href}>{props.children as never}</a>,
}));

import { GameClient, type GameClientProps } from '@/app/(authed)/sessions/[id]/game-client';

const SESSION_ID = 'sess-begin-1';

// EventSource that NEVER dispatches an event — recovery must come from the poll.
class MockEventSource {
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  readyState = 1;
  static instances: MockEventSource[] = [];
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close(): void {
    this.readyState = 2;
  }
}

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

function character(): Character {
  return {
    id: 'pc-1', name: 'Tharion', raceSlug: 'half-elf', classSlug: 'fighter',
    level: 1, xp: 0, hpMax: 12, ac: 14, speed: 30, proficiencyBonus: 2,
    abilities: { STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [], features: [],
  } as unknown as Character;
}

function state(): SessionStateRow {
  return {
    sessionId: SESSION_ID, hpCurrent: 12, tempHp: 0, hitDiceRemaining: 1,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null,
    scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
  } as unknown as SessionStateRow;
}

function props(): GameClientProps {
  return {
    sessionId: SESSION_ID,
    session: { id: SESSION_ID, language: 'it' } as unknown as SessionRow,
    campaign: {
      id: 'camp-1', name: 'Test Campaign', language: 'it', aiMasterModel: null,
      settings: { sourceOfTruth: 'vault' },
    } as unknown as CampaignRow,
    character: character(),
    initialState: state(),
    initialMessages: [], // ← empty → the begin auto-fire kicks off the opener
    initialActors: [],
    initialAutoplay: false,
    initialManualRolls: false,
    initialImageGenerationEnabled: false,
  };
}

let serverMessages: MessageRow[] = [];

async function flush(times = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('GameClient begin-turn stuck composer (SSE-drop, vault)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    serverMessages = [];

    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === `/api/sessions/${SESSION_ID}`) {
        return jsonResponse({
          session: { id: SESSION_ID, language: 'it' },
          campaign: { id: 'camp-1', name: 'Test Campaign', settings: { sourceOfTruth: 'vault' } },
          state: state(),
          character: null,
          party: [],
          actors: [],
          currentPlayerCharacterId: null,
          viewerCharacterId: null,
        });
      }
      if (url === `/api/sessions/${SESSION_ID}/messages`) return jsonResponse({ messages: serverMessages });
      if (url === `/api/sessions/${SESSION_ID}/character`) return jsonResponse({ character: character() });
      if (url === `/api/sessions/${SESSION_ID}/turn` && method === 'POST') return jsonResponse({ ok: true }, true, 202);
      return jsonResponse({}, false, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('unlocks the composer when the safety poll recovers the opener after a dropped completion SSE', async () => {
    render(<GameClient {...props()} />);
    await flush(); // on-mount fetch + memory-ready → begin auto-fire posts

    const composer = screen.getByTestId('composer');
    // Begin turn is in flight: turnStatus.isBegin → busy → composer locked,
    // showing the campaign-generating label.
    expect(composer.getAttribute('data-disabled')).toBe('true');
    expect(composer.getAttribute('data-label')).toBe('The Master is generating the campaign…');

    // Server persisted the opener, but the completion SSE was DROPPED — no SSE
    // event is ever dispatched. Only the HTTP safety poll can recover it.
    serverMessages = [
      {
        id: 'm-opener-1', sessionId: SESSION_ID, role: 'master',
        content: 'Ti trovi nell’ingresso di una galleria sotterranea. Che fai?',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as unknown as MessageRow,
    ];

    // Advance to the 3s poll tick: it detects the new master message and recovers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flush();

    // The composer must be ENABLED again without a page refresh — turnStatus is
    // cleared by the safety-poll recovery, so `busy` drops to false.
    expect(composer.getAttribute('data-disabled')).toBe('false');
  });
});
