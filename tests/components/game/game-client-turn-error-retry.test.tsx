import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Character } from '@/engine/types';
import type { CampaignRow, MessageRow, SessionRow, SessionStateRow } from '@/sessions/client-types';

/**
 * A turn that fails with `empty_response` (local model emitted only <think>…
 * tokens → stripped → no narration) must NOT leave the UI stuck "responding"
 * forever. The error surfaces a RETRY action that re-POSTs the turn — for the
 * opening begin-turn this is the only escape (beganRef latched true, so the
 * auto-open effect never re-fires on its own).
 */

vi.mock('@/components/game/narrative-pane', () => ({
  NarrativePane: (props: { onSend: (t: string) => void }) => (
    <button onClick={() => props.onSend('I attack the goblin')}>send-stub</button>
  ),
}));
vi.mock('@/components/game/character-pane', () => ({ CharacterPane: () => null }));
vi.mock('@/components/game/autoplay-toggle', () => ({ AutoplayToggle: () => null }));
// Banner mock fires onReady on mount so the begin-turn auto-open effect runs
// (memoryReady gate) deterministically in the test.
vi.mock('@/components/memory-status-banner', () => ({
  MemoryStatusBanner: (props: { onReady?: () => void }) => {
    props.onReady?.();
    return null;
  },
}));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: unknown }) => <a href={props.href}>{props.children as never}</a>,
}));

import { GameClient, type GameClientProps } from '@/app/(authed)/sessions/[id]/game-client';

const SESSION_ID = 'sess-err-1';

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
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

function character(): Character {
  return {
    id: 'pc-1', name: 'Tharion', raceSlug: 'half-elf', classSlug: 'fighter',
    level: 1, xp: 0, hpMax: 13, ac: 16, speed: 30, proficiencyBonus: 2,
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [], features: [],
  } as unknown as Character;
}

function exploreState(): SessionStateRow {
  return {
    sessionId: SESSION_ID, hpCurrent: 13, tempHp: 0, hitDiceRemaining: 1,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null, scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
  } as unknown as SessionStateRow;
}

function props(): GameClientProps {
  return {
    sessionId: SESSION_ID,
    session: { id: SESSION_ID, language: 'en' } as unknown as SessionRow,
    campaign: {
      id: 'camp-err', name: 'Goblin Warren', language: 'en', aiMasterModel: null,
      settings: { sourceOfTruth: 'vault' },
    } as unknown as CampaignRow,
    character: character(),
    initialState: exploreState(),
    initialMessages: [], // empty → begin-turn auto-opens
    initialActors: [],
    initialAutoplay: false,
    initialManualRolls: false,
    initialImageGenerationEnabled: false,
  };
}

let turnPostCount = 0;

async function flush(times = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('GameClient — empty_response turn-error retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    turnPostCount = 0;

    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === `/api/sessions/${SESSION_ID}` ) return jsonResponse(null);
      if (url === `/api/sessions/${SESSION_ID}/messages`) return jsonResponse({ messages: [] as MessageRow[] });
      if (url === `/api/sessions/${SESSION_ID}/character`) return jsonResponse({ character: character() });
      if (url === `/api/sessions/${SESSION_ID}/turn` && method === 'POST') {
        turnPostCount += 1;
        return jsonResponse({ ok: true }, true, 202);
      }
      return jsonResponse({}, false, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a Retry action on empty_response and re-POSTs the turn when clicked', async () => {
    render(<GameClient {...props()} />);
    // Banner mock fires onReady on mount → memoryReady → begin-turn auto-opens.
    await flush();
    expect(turnPostCount).toBe(1);

    // The server reports the opening turn produced no narration.
    await act(async () => {
      MockEventSource.instances[0]?.emit({ type: 'turn-error', reason: 'empty_response', message: 'Il Master non ha prodotto una risposta. Riprova o riformula.' });
    });
    await flush();

    // A Retry control must be offered (not just a dismiss).
    const retry = screen.getByRole('button', { name: /riprova|retry/i });
    expect(retry).toBeInTheDocument();

    // Clicking it re-issues the turn.
    await act(async () => {
      fireEvent.click(retry);
    });
    await flush();
    expect(turnPostCount).toBe(2);
  });
});
