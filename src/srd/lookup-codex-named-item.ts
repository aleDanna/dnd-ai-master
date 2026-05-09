import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { codexEntities, type CodexNamedItemData } from '@/db/schema';

// Helper extracted to its own module so `src/srd/catalog.ts` doesn't pull in
// the codex schema at every import site (smaller blast radius, easier to
// stub in unit tests).

export interface NamedItemLookupResult {
  kind: 'named_item';
  sessionId: string;
  slug: string;
  name: string;
  description: string;
  magical: boolean;
}

export async function lookupNamedItemBySlug(
  sessionId: string,
  slug: string,
): Promise<NamedItemLookupResult | null> {
  const [row] = await db
    .select()
    .from(codexEntities)
    .where(
      and(
        eq(codexEntities.sessionId, sessionId),
        eq(codexEntities.kind, 'named_item'),
        eq(codexEntities.slug, slug),
      ),
    )
    .limit(1);
  if (!row) return null;
  const data = row.data as CodexNamedItemData;
  return {
    kind: 'named_item',
    sessionId,
    slug: row.slug,
    name: row.name,
    description: data.description,
    magical: data.magical,
  };
}
