import type { ActionResult, EngineState } from '../types';
import { db } from '@/db/client';
import { codexEntities } from '@/db/schema';
import { slugify } from '@/srd/util/slug';

// New flavor-only inventory channel. Unlike `add_item` (which validates the
// slug against SRD catalog + codex named_items), this tool accepts a
// free-form `name`, slugifies it, and persists it as a `named_item` codex
// entry with `magical: false`. The PC's inventory then references the slug
// like any other item. The left-pane UI reads `magical: false` named items
// and renders them with a `(narrativo)` suffix so the player understands
// they have no mechanical effect.
//
// Idempotency: the codex entry is reused on slug collision (no destructive
// upsert; the codex auto-update pipeline owns name/description rewrites).
// The inventory mutation is NOT idempotent (per the master's tool contract)
// — calling twice adds qty twice.

const NAME_MAX = 80;
const DESC_MAX = 120;

export async function addNarrativeItem(
  ctx: { sessionId: string; state: EngineState },
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const pc = ctx.state.characters[0];
  if (!pc) return { ok: false, error: 'unknown_actor', rolls: [], mutations: [] };

  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  if (!rawName || rawName.length > NAME_MAX) {
    return { ok: false, error: 'invalid_name', rolls: [], mutations: [] };
  }

  let slug: string;
  try {
    slug = slugify(rawName);
  } catch {
    return { ok: false, error: 'invalid_name', rolls: [], mutations: [] };
  }

  const qty = Math.max(1, Math.floor(Number(input.qty ?? 1) || 1));

  const rawDesc = typeof input.description === 'string' ? input.description : '';
  const description = rawDesc.length > DESC_MAX ? rawDesc.slice(0, DESC_MAX) : rawDesc;

  // INSERT ... ON CONFLICT DO NOTHING against the unique index
  // codex_entities_session_kind_slug_uniq. If the row already exists (codex
  // auto-update or a duplicate same-turn call), we skip the insert and
  // proceed directly to the inventory mutation. The codex pipeline owns
  // updates to existing rows; we never overwrite name/description here.
  await db
    .insert(codexEntities)
    .values({
      sessionId: ctx.sessionId,
      kind: 'named_item',
      slug,
      name: rawName,
      data: { description, magical: false },
    })
    .onConflictDoNothing({
      target: [codexEntities.sessionId, codexEntities.kind, codexEntities.slug],
    });

  return {
    ok: true,
    rolls: [],
    mutations: [{ op: 'add_inventory', characterId: pc.id, itemSlug: slug, qty }],
    data: { slug, name: rawName, qty, kind: 'named_item' },
  };
}
