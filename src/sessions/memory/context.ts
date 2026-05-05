import { eq, and, asc, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessionMessages,
  sessionChapters,
  codexEntities,
  type CodexEntity,
  type CodexQuestData,
} from '@/db/schema';

export interface MemoryContext {
  chapterDigests: string;
  sceneCard: string;
  codexIndex: string;
}

const SCENE_CARD_CAP = 15;
const RECENT_MESSAGES_FOR_LASTSEEN = 5;

function formatEntityForCard(e: CodexEntity): string {
  const dataPreview = ((): string => {
    if (e.kind === 'npc') {
      const d = e.data as { description: string; status: string; disposition: string };
      return `[${d.status}, ${d.disposition}] ${d.description}`;
    }
    if (e.kind === 'quest') {
      const d = e.data as CodexQuestData;
      return `[${d.status}] ${d.description}`;
    }
    if (e.kind === 'location') {
      const d = e.data as { description: string };
      return d.description;
    }
    if (e.kind === 'lore_fact') {
      const d = e.data as { statement: string };
      return d.statement;
    }
    if (e.kind === 'faction') {
      const d = e.data as { description: string; pcRelation: string };
      return `[${d.pcRelation}] ${d.description}`;
    }
    if (e.kind === 'named_item') {
      const d = e.data as { description: string };
      return d.description;
    }
    if (e.kind === 'relationship') {
      const d = e.data as { fromSlug: string; toSlug: string; nature: string };
      return `${d.fromSlug} → ${d.toSlug}: ${d.nature}`;
    }
    return '';
  })();
  return `- (${e.kind}) ${e.name} [${e.slug}]: ${dataPreview}`;
}

export async function loadMemoryContext(sessionId: string, sceneText: string): Promise<MemoryContext> {
  // 1. Chapter digests — all chapters in order.
  const chapters = await db
    .select({ chapterIndex: sessionChapters.chapterIndex, summary: sessionChapters.summary })
    .from(sessionChapters)
    .where(eq(sessionChapters.sessionId, sessionId))
    .orderBy(asc(sessionChapters.chapterIndex));

  const chapterDigests =
    chapters.length === 0
      ? ''
      : chapters.map((c) => `## Chapter ${c.chapterIndex}\n${c.summary}`).join('\n\n');

  // 2. Codex full read — used for both index and scene card selection.
  const allEntities = await db
    .select()
    .from(codexEntities)
    .where(eq(codexEntities.sessionId, sessionId));

  // codex index — bare names per kind.
  let codexIndex = '';
  if (allEntities.length === 0) {
    codexIndex = '(empty codex)';
  } else {
    const byKind = new Map<string, string[]>();
    for (const e of allEntities) {
      const arr = byKind.get(e.kind) ?? [];
      arr.push(e.name);
      byKind.set(e.kind, arr);
    }
    codexIndex = Array.from(byKind.entries())
      .map(([k, ns]) => `${k}s: [${ns.join(', ')}]`)
      .join('\n');
  }

  // 3. Scene card selection:
  //    a. open quests (always)
  //    b. entities whose name or slug appears in sceneText or last player message
  //    c. entities last_seen_msg_id within the last RECENT_MESSAGES_FOR_LASTSEEN messages
  //    dedup; cap at SCENE_CARD_CAP; sort by lastSeenMsgId desc nulls last.

  const lastPlayerRows = await db
    .select({ id: sessionMessages.id, content: sessionMessages.content })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, 'player')))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(1);
  const lastPlayerText = lastPlayerRows[0]?.content ?? '';
  const haystack = `${sceneText}\n${lastPlayerText}`.toLowerCase();

  const recentMsgRows = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(RECENT_MESSAGES_FOR_LASTSEEN);
  const recentIds = new Set(recentMsgRows.map((r) => r.id));

  const picked = new Map<string, CodexEntity>();
  for (const e of allEntities) {
    if (e.kind === 'quest') {
      const d = e.data as CodexQuestData;
      if (d.status === 'open') picked.set(e.id, e);
      continue;
    }
    const slugMatch = haystack.includes(e.slug.toLowerCase());
    const nameMatch = haystack.includes(e.name.toLowerCase());
    if (slugMatch || nameMatch) {
      picked.set(e.id, e);
      continue;
    }
    if (e.lastSeenMsgId && recentIds.has(e.lastSeenMsgId)) {
      picked.set(e.id, e);
    }
  }

  const sorted = Array.from(picked.values()).sort((a, b) => {
    if (!a.lastSeenMsgId && !b.lastSeenMsgId) return 0;
    if (!a.lastSeenMsgId) return 1;
    if (!b.lastSeenMsgId) return -1;
    return a.lastSeenMsgId === b.lastSeenMsgId ? 0 : a.lastSeenMsgId > b.lastSeenMsgId ? -1 : 1;
  });
  const capped = sorted.slice(0, SCENE_CARD_CAP);

  const sceneCard =
    capped.length === 0
      ? '(no entities currently in scene)'
      : capped.map(formatEntityForCard).join('\n');

  return { chapterDigests, sceneCard, codexIndex };
}
