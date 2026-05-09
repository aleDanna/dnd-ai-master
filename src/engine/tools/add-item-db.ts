import type { ActionResult, EngineState } from '../types';
import { lookupCatalogItem } from '@/srd/catalog';
import { resolveCharacterId } from './handlers';

// DB-backed `add_item`: validates the slug against the SRD catalog
// (srd_weapon / srd_armor / srd_gear), the standard currency codes
// (gp/sp/cp/ep/pp), or the session-scoped codex named_items. Master
// attempts to add an unknown item are rejected with `unknown_item:{slug}`
// so we never invent inventory rows that don't reference a real entity.
//
// Custom magic items the master has narrated must first be persisted to
// the codex (kind=named_item) — only then can they be added to the PC's
// inventory. This is intentional: it forces unique items through a single
// canonical record so we don't end up with five different "Sword of
// Aldric" duplicates from typos.

export async function addItemDb(
  ctx: { sessionId: string; state: EngineState },
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const charId = resolveCharacterId(ctx.state, input.actor);
  const char = ctx.state.characters.find((c) => c.id === charId);
  if (!char) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };

  const slug = String(input.slug || '').trim().toLowerCase();
  if (!slug) return { ok: false, error: 'invalid_slug', rolls: [], mutations: [] };
  const qty = Math.max(1, Math.floor(Number(input.qty ?? 1) || 1));

  const item = await lookupCatalogItem(slug, { sessionId: ctx.sessionId });
  if (!item) {
    return {
      ok: false,
      error: `unknown_item:${slug}`,
      rolls: [],
      mutations: [],
    };
  }

  return {
    ok: true,
    rolls: [],
    mutations: [{ op: 'add_inventory', characterId: char.id, itemSlug: slug, qty }],
    data: { slug, qty, kind: item.kind },
  };
}
