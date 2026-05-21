import { db } from '@/db/client';
import {
  codexEntities,
  sessionChapters,
  type CodexEntityInsert,
  type CodexNpcData,
  type CodexLocationData,
  type CodexQuestData,
  type CodexFactionData,
  type CodexLoreFactData,
  type CodexNamedItemData,
  type CodexRelationshipData,
} from '@/db/schema';
import type { CodexUpsert, MemoryPatch } from './types';

export function validateUpsert(u: CodexUpsert): void {
  const { kind, data } = u;
  const need = (b: boolean, msg: string): void => {
    if (!b) throw new Error(`patch_invalid:${kind}:${msg}`);
  };
  if (typeof u.slug !== 'string' || !u.slug.length) throw new Error(`patch_invalid:${kind}:slug`);
  if (typeof u.name !== 'string' || !u.name.length) throw new Error(`patch_invalid:${kind}:name`);

  if (kind === 'npc') {
    const d = data as CodexNpcData;
    need(typeof d.description === 'string' && d.description.length > 0, 'description');
    need(['alive', 'dead', 'unknown'].includes(d.status), 'status');
    need(['ally', 'neutral', 'hostile', 'unknown'].includes(d.disposition), 'disposition');
    need(Array.isArray(d.tags), 'tags');
  } else if (kind === 'location') {
    const d = data as CodexLocationData;
    need(typeof d.description === 'string' && d.description.length > 0, 'description');
    need(Array.isArray(d.tags), 'tags');
  } else if (kind === 'quest') {
    const d = data as CodexQuestData;
    need(typeof d.description === 'string' && d.description.length > 0, 'description');
    need(['open', 'completed', 'failed', 'abandoned'].includes(d.status), 'status');
  } else if (kind === 'faction') {
    const d = data as CodexFactionData;
    need(typeof d.description === 'string' && d.description.length > 0, 'description');
    need(['ally', 'neutral', 'hostile', 'unknown'].includes(d.pcRelation), 'pcRelation');
  } else if (kind === 'lore_fact') {
    const d = data as CodexLoreFactData;
    need(typeof d.statement === 'string' && d.statement.length > 0, 'statement');
    need(Array.isArray(d.tags), 'tags');
  } else if (kind === 'named_item') {
    const d = data as CodexNamedItemData;
    need(typeof d.description === 'string' && d.description.length > 0, 'description');
    need(typeof d.magical === 'boolean', 'magical');
  } else if (kind === 'relationship') {
    const d = data as CodexRelationshipData;
    need(typeof d.fromSlug === 'string' && d.fromSlug.length > 0, 'fromSlug');
    need(typeof d.toSlug === 'string' && d.toSlug.length > 0, 'toSlug');
    need(typeof d.nature === 'string' && d.nature.length > 0, 'nature');
  } else {
    throw new Error(`patch_invalid:unknown_kind:${String(kind)}`);
  }
}

/** Split upserts into the ones that pass shape validation and the ones that
 * don't. The caller decides what to do with the rejects (typically: log + skip).
 *
 * Motivation: weak local LLMs (notably the qwen3:30b-a3b family baked as
 * `dnd-master-max3`) occasionally emit a `named_item` upsert without the
 * mandatory `magical: boolean`, or pick a non-enum value for `npc.disposition`.
 * Before this helper, the extractor handed the raw list to `applyPatch` —
 * one malformed row caused the WHOLE batch (including a valid chapter
 * summary in FULL mode) to be discarded silently, degrading narrative
 * continuity over time. `applyPatch` itself stays fail-atomic so callers
 * that don't pre-filter still get all-or-nothing semantics. */
export function partitionUpserts(upserts: CodexUpsert[]): {
  valid: CodexUpsert[];
  invalid: { upsert: CodexUpsert; reason: string }[];
} {
  const valid: CodexUpsert[] = [];
  const invalid: { upsert: CodexUpsert; reason: string }[] = [];
  for (const u of upserts) {
    try {
      validateUpsert(u);
      valid.push(u);
    } catch (e) {
      invalid.push({ upsert: u, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { valid, invalid };
}

/** Apply a memory patch atomically.
 *
 * Slug contract: the caller (extractor / prompt) is responsible for producing
 * canonical slugs (lowercase, ASCII, hyphenated). This function does NOT
 * normalize them — it would obscure debugging when the slug stored differs
 * from what the LLM emitted. If two upserts in the same patch use slugs that
 * differ only in case, they are treated as distinct entities.
 *
 * Throws BEFORE opening the transaction on shape violations, so no partial
 * writes are possible. Designed to be safe to retry: upserts use
 * (session_id, kind, slug) as the conflict target; chapters dedup by
 * (session_id, chapter_index). */
export async function applyPatch(sessionId: string, patch: MemoryPatch): Promise<void> {
  for (const u of patch.upserts) validateUpsert(u);

  await db.transaction(async (tx) => {
    for (const u of patch.upserts) {
      const row: CodexEntityInsert = {
        sessionId,
        kind: u.kind,
        slug: u.slug,
        name: u.name,
        data: u.data,
        lastSeenMsgId: patch.lastSeenMsgId,
      };
      await tx
        .insert(codexEntities)
        .values(row)
        .onConflictDoUpdate({
          target: [codexEntities.sessionId, codexEntities.kind, codexEntities.slug],
          set: {
            name: row.name,
            data: row.data,
            lastSeenMsgId: row.lastSeenMsgId,
            updatedAt: new Date(),
          },
        });
    }

    if (patch.chapter) {
      await tx
        .insert(sessionChapters)
        .values({
          sessionId,
          chapterIndex: patch.chapter.chapterIndex,
          firstMsgId: patch.chapter.firstMsgId,
          lastMsgId: patch.chapter.lastMsgId,
          messageCount: patch.chapter.messageCount,
          summary: patch.chapter.summary,
        })
        .onConflictDoNothing({
          target: [sessionChapters.sessionId, sessionChapters.chapterIndex],
        });
    }
  });
}
