import type { Position } from '../types';

export function initialPosition(): Position {
  return { band: 'near', engagedWith: [] };
}

export function isEngaged(p: Position): boolean {
  return p.engagedWith.length > 0;
}

export function movementProvokesOA(from: Position, to: Position, disengaged: boolean): string[] {
  if (disengaged) return [];
  if (!isEngaged(from)) return [];
  // Anyone who WAS engaging us but ISN'T anymore triggers an OA.
  return from.engagedWith.filter((id) => !to.engagedWith.includes(id));
}

export function enterEngagement(p: Position, enemyId: string): Position {
  if (p.engagedWith.includes(enemyId)) return p;
  return { band: 'engaged', engagedWith: [...p.engagedWith, enemyId] };
}

export function leaveEngagement(p: Position, enemyId: string): Position {
  const next = p.engagedWith.filter((id) => id !== enemyId);
  return {
    band: next.length > 0 ? 'engaged' : p.band === 'engaged' ? 'near' : p.band,
    engagedWith: next,
  };
}

const BAND_ORDER: Position['band'][] = ['engaged', 'near', 'far', 'distant'];
const INTERVAL: Record<string, number> = {
  'engaged-near': 5,
  'near-engaged': 5,
  'near-far': 25,
  'far-near': 25,
  'far-distant': 60,
  'distant-far': 60,
};

export function bandTransitionDistance(from: Position['band'], to: Position['band']): number {
  if (from === to) return 0;
  const fromIdx = BAND_ORDER.indexOf(from);
  const toIdx = BAND_ORDER.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return 0;
  let total = 0;
  if (fromIdx < toIdx) {
    for (let i = fromIdx; i < toIdx; i++) total += INTERVAL[`${BAND_ORDER[i]}-${BAND_ORDER[i + 1]}`] ?? 0;
  } else {
    for (let i = fromIdx; i > toIdx; i--) total += INTERVAL[`${BAND_ORDER[i]}-${BAND_ORDER[i - 1]}`] ?? 0;
  }
  return total;
}
