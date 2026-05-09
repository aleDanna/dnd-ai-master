import type { ActionResult, EngineState } from '../types';
import { db } from '@/db/client';
import { codexEntities } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
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

  // Read-then-insert. A unique-violation race (codex auto-update inserting
  // the same slug between our SELECT and INSERT) is caught and treated as
  // success — the entry exists, that's all we need before the inventory
  // mutation is queued.
  const [existing] = await db
    .select()
    .from(codexEntities)
    .where(
      and(
        eq(codexEntities.sessionId, ctx.sessionId),
        eq(codexEntities.kind, 'named_item'),
        eq(codexEntities.slug, slug),
      ),
    )
    .limit(1);

  if (!existing) {
    try {
      await db.insert(codexEntities).values({
        sessionId: ctx.sessionId,
        kind: 'named_item',
        slug,
        name: rawName,
        data: { description, magical: false },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate key|unique/i.test(msg)) {
        return { ok: false, error: 'db_failed', rolls: [], mutations: [] };
      }
      // race with concurrent insert — proceed
    }
  }

  return {
    ok: true,
    rolls: [],
    mutations: [{ op: 'add_inventory', characterId: pc.id, itemSlug: slug, qty }],
    data: { slug, name: rawName, qty, kind: 'named_item' },
  };
}
