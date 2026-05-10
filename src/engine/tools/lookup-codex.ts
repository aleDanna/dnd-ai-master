import { eq, and, ilike, or, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { codexEntities } from '@/db/schema';
import type { ActionResult } from '../types';

const VALID_KINDS = ['npc', 'location', 'quest', 'faction', 'lore_fact', 'named_item', 'relationship'];
const MAX_RESULT_BYTES = 2048;
const MAX_MATCHES = 5;

export interface LookupCodexCtx {
  sessionId: string;
}

export async function lookupCodex(
  ctx: LookupCodexCtx,  // DbToolCtx is a structural superset; extra `state` field is ignored.
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const kind = String(input.kind ?? '');
  const query = String(input.query ?? '');
  if (!VALID_KINDS.includes(kind)) {
    return { ok: false, error: `invalid_kind:${kind}`, rolls: [], mutations: [] };
  }
  if (!query) {
    return { ok: false, error: 'invalid_query:empty', rolls: [], mutations: [] };
  }
  const pattern = `%${query}%`;
  const rows = await db
    .select()
    .from(codexEntities)
    .where(
      and(
        eq(codexEntities.sessionId, ctx.sessionId),
        eq(codexEntities.kind, kind as never),
        or(ilike(codexEntities.slug, pattern), ilike(codexEntities.name, pattern)),
      ),
    )
    .orderBy(desc(codexEntities.updatedAt))
    .limit(MAX_MATCHES);

  let truncated = false;
  const matches = rows.map((r) => ({
    kind: r.kind,
    slug: r.slug,
    name: r.name,
    data: r.data,
    lastSeenMsgId: r.lastSeenMsgId,
  }));

  let payload: { matches: typeof matches; truncated: boolean } = { matches, truncated };
  if (JSON.stringify(payload).length > MAX_RESULT_BYTES) {
    truncated = true;
    payload = {
      matches: matches.map((m) => ({ ...m, data: { description: '(truncated)' } as never })),
      truncated,
    };
  }

  return { ok: true, data: payload, rolls: [], mutations: [] };
}
