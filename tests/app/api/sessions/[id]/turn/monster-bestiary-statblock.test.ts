import { describe, it, expect } from 'vitest';
import { getBestiaryStatblock } from '@/app/api/sessions/[id]/turn/monster-bestiary';

// Phase 10 Plan 02 — TDD RED suite: getBestiaryStatblock reads hpMax/ac/cr
// from the SRD bestiary frontmatter (NOT the Actions prose).
//
// The goblin.md frontmatter (committed at data/vault/handbook/monsters/goblin.md):
//   hpMax: 7, ac: 15, cr: "1/4"
//
// readVaultFile reads the committed handbook path directly — no fs seeding
// or VAULT_CAMPAIGNS_ROOT stubbing needed.

describe('getBestiaryStatblock', () => {
  it('reads goblin.md frontmatter and returns real seeded stats', async () => {
    const stats = await getBestiaryStatblock('goblin');
    expect(stats).toEqual({ hpMax: 7, ac: 15, cr: '1/4' });
  });

  it('case-normalizes: "Goblin" (uppercase) resolves to the same goblin stats', async () => {
    const stats = await getBestiaryStatblock('Goblin');
    expect(stats).toEqual({ hpMax: 7, ac: 15, cr: '1/4' });
  });

  it('whitespace-normalizes: " goblin " (padded) resolves to the same goblin stats', async () => {
    const stats = await getBestiaryStatblock(' goblin ');
    expect(stats).toEqual({ hpMax: 7, ac: 15, cr: '1/4' });
  });

  it('returns null for an unknown monster (no bestiary file)', async () => {
    expect(await getBestiaryStatblock('no-such-monster-xyz')).toBeNull();
  });

  it('returns null (never throws) for a path-traversal input', async () => {
    await expect(getBestiaryStatblock('../../etc/passwd')).resolves.toBeNull();
  });
});
