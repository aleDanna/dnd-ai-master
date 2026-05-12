export type PartyMember = { id: string; createdAt: Date };

/**
 * Given a sorted-by-created-at party and the current character's id, return
 * the next character. Wraps around. If the current id isn't in the party,
 * returns the first. Throws on empty party.
 */
export function nextInParty<T extends PartyMember>(currentId: string, party: T[]): T {
  if (party.length === 0) throw new Error('empty party');
  const idx = party.findIndex((c) => c.id === currentId);
  if (idx === -1) return party[0]!;
  return party[(idx + 1) % party.length]!;
}
