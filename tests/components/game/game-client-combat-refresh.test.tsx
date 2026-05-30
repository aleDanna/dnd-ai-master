import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Character } from '@/engine/types';
import type {
  CampaignRow,
  CombatActorRow,
  MessageRow,
  SessionRow,
  SessionStateRow,
} from '@/sessions/client-types';

// --- Mock only the heavy / irrelevant children so the render isolates the
// combat-tracker refresh wiring in GameClient. MechanicsPane (which hosts the
// CombatTracker) is intentionally left REAL — it is the subject under test. ---

// Deterministic send trigger. The real NarrativePane composer is gated by
// `disabled` (memory ready / whose turn / busy); the stub bypasses that gate
// and calls `onSend` directly. The recovery path under test is independent of
// the composer gate, so driving send() this way is faithful to a player taking
// a combat action mid-session.
vi.mock('@/components/game/narrative-pane', () => ({
  NarrativePane: (props: { onSend: (t: string) => void }) => (
    <button onClick={() => props.onSend('I attack the goblin')}>send-stub</button>
  ),
}));
vi.mock('@/components/game/character-pane', () => ({ CharacterPane: () => null }));
vi.mock('@/components/game/autoplay-toggle', () => ({ AutoplayToggle: () => null }));
vi.mock('@/components/memory-status-banner', () => ({ MemoryStatusBanner: () => null }));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: unknown }) => <a href={props.href}>{props.children as never}</a>,
}));

import { GameClient, type GameClientProps } from '@/app/(authed)/sessions/[id]/game-client';

const SESSION_ID = 'sess-1';

// Minimal EventSource stand-in: the hook constructs one but, in the dropped-
// `message` scenario, NO SSE event is ever dispatched — recovery must come from
// the HTTP safety poll alone.
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
    level: 3, xp: 900, hpMax: 27, ac: 16, speed: 30, proficiencyBonus: 2,
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [], features: [],
  } as unknown as Character;
}

// Combat state at a given round. The PC (`pc-1`, idx 0) and a goblin
// (`goblin-1`, idx 1) are in initiative order.
function combatState(round: number, hpCurrent: number): SessionStateRow {
  return {
    sessionId: SESSION_ID, hpCurrent, tempHp: 0, hitDiceRemaining: 3,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: true,
    combat: {
      round,
      currentIdx: 0,
      turnOrder: [
        { actorId: 'pc-1', initiative: 18 },
        { actorId: 'goblin-1', initiative: 12 },
      ],
    },
    scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
  } as unknown as SessionStateRow;
}

function goblin(hpCurrent: number): CombatActorRow {
  return { id: 'goblin-1', name: 'Goblin', hpCurrent, hpMax: 7, isAlive: true } as unknown as CombatActorRow;
}

function props(): GameClientProps {
  return {
    sessionId: SESSION_ID,
    session: { id: SESSION_ID, language: 'en' } as unknown as SessionRow,
    // Vault campaign: on this path the server never emits a `state` SSE event,
    // so the snapshot refetch is the ONLY combat-tracker refresh trigger.
    campaign: {
      id: 'camp-1', name: 'Test Campaign', language: 'en', aiMasterModel: null,
      settings: { sourceOfTruth: 'vault' },
    } as unknown as CampaignRow,
    character: character(),
    initialState: combatState(1, 27), // SSR'd: combat at round 1
    initialMessages: [],
    initialActors: [goblin(7)], // SSR'd: goblin at full HP
    initialAutoplay: false,
    initialManualRolls: false,
    initialImageGenerationEnabled: false,
  };
}

// Mutable server state the mocked endpoints read at call time.
let serverMessages: MessageRow[] = [];
let serverSnapshot: unknown = null;
let snapshotFetchCount = 0;

async function flush(times = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('GameClient combat-tracker SSE-drop recovery (vault)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    snapshotFetchCount = 0;
    serverMessages = [];
    // The session snapshot the recovery refetch should pull: combat advanced to
    // round 2, PC took damage (27 -> 20), goblin bloodied (7 -> 2).
    serverSnapshot = {
      session: { id: SESSION_ID, language: 'en' },
      campaign: { id: 'camp-1', name: 'Test Campaign', settings: { sourceOfTruth: 'vault' } },
      state: combatState(2, 20),
      character: null,
      party: [],
      actors: [goblin(2)],
      currentPlayerCharacterId: null,
      viewerCharacterId: null,
    };

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
        snapshotFetchCount += 1;
        return jsonResponse(serverSnapshot);
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

  it('refreshes the combat tracker when a dropped master message is recovered by the safety poll', async () => {
    render(<GameClient {...props()} />);
    await flush(); // settle on-mount fetchSessionData (messages + character)

    // Tracker renders the SSR'd combat at round 1 (no SSE snapshot yet).
    expect(screen.getByText(/Combat · Round 1/)).toBeInTheDocument();
    expect(snapshotFetchCount).toBe(0);

    // Player takes a combat action -> arms the 3s safety poll.
    await act(async () => {
      fireEvent.click(screen.getByText('send-stub'));
    });
    await flush();

    // Server persisted the master's monster-turn response (combat -> round 2),
    // but the `message` SSE event was DROPPED in transit, so NO SSE refetch
    // fires. Only the HTTP safety poll can recover.
    serverMessages = [
      {
        id: 'm-master-1', sessionId: SESSION_ID, role: 'master',
        content: 'The goblin lunges as the round turns.',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as unknown as MessageRow,
    ];

    // Advance to the poll tick: it detects the new master message and recovers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flush();

    // The recovery must also refetch the session snapshot so the combat tracker
    // reflects round 2 / the new HP. Pre-fix it only recovered chat + character
    // and left the tracker pinned at round 1.
    expect(snapshotFetchCount).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Combat · Round 2/)).toBeInTheDocument();
    expect(screen.getByText('2/7')).toBeInTheDocument(); // goblin HP refreshed
  });
});
