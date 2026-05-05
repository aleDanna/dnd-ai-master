import { eq, and, asc, gt, or, not, like, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessions,
  sessionMessages,
  sessionChapters,
  codexEntities,
  type SessionMessage,
} from '@/db/schema';
import { applyPatch } from './patch';
import {
  buildExtractorSystemPrompt,
  formatExistingCodex,
  formatPreviousChapters,
  formatMessagesForExtractor,
} from './prompt';
import type { CodexUpsert, ExtractorMode, MemoryPatch } from './types';
import { getMasterProvider } from '@/ai/provider';
import type { MasterProvider } from '@/ai/provider/types';

const CHAPTER_SIZE = 40;

let _override: MasterProvider | null = null;
/** Test-only seam. */
export function __setExtractorProviderForTest(p: MasterProvider | null): void {
  _override = p;
}

function provider(): MasterProvider {
  return _override ?? getMasterProvider();
}

/** Acquire a per-session advisory lock. Returns true if acquired.
 *
 * Lock-key contract: `pg_try_advisory_lock(hashtextextended(sessionId, 0))`.
 * Any other code that needs mutual exclusion against extractMemory (e.g. the
 * rebuild endpoint) MUST use the SAME function — otherwise the keys hash to
 * different buckets and the locks don't contend. We use `hashtextextended`
 * (64-bit) instead of plain `hashtext` (32-bit) for a much smaller collision
 * surface across active sessions. */
async function tryLock(sessionId: string): Promise<boolean> {
  const r = await db.execute<{ pg_try_advisory_lock: boolean }>(
    sql`select pg_try_advisory_lock(hashtextextended(${sessionId}, 0)) as pg_try_advisory_lock`,
  );
  // drizzle returns rows on .rows; shape may differ across pg drivers. Be defensive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (r as any).rows?.[0] ?? (r as any)[0];
  return row?.pg_try_advisory_lock === true;
}

async function unlock(sessionId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_unlock(hashtextextended(${sessionId}, 0))`,
  );
}

async function getNonOocMessagesAfter(
  sessionId: string,
  afterId: string | null,
): Promise<SessionMessage[]> {
  if (afterId === null) {
    return db
      .select()
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          not(like(sessionMessages.content, '!%')),
        ),
      )
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  }
  const [pivot] = await db
    .select({ createdAt: sessionMessages.createdAt, id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.id, afterId))
    .limit(1);
  if (!pivot) {
    return db
      .select()
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          not(like(sessionMessages.content, '!%')),
        ),
      )
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  }
  return db
    .select()
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.sessionId, sessionId),
        or(
          gt(sessionMessages.createdAt, pivot.createdAt),
          and(
            eq(sessionMessages.createdAt, pivot.createdAt),
            gt(sessionMessages.id, pivot.id),
          ),
        ),
        not(like(sessionMessages.content, '!%')),
      ),
    )
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
}

interface ExtractorContext {
  sessionId: string;
  language: string | null;
  mode: ExtractorMode;
  inputMessages: SessionMessage[];
  existingCodex: { kind: string; slug: string; name: string; data: unknown }[];
  previousChapters: { chapterIndex: number; summary: string }[];
  nextChapterIndex: number;
}

async function buildContext(sessionId: string): Promise<ExtractorContext | null> {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!s) return null;

  const chapters = await db
    .select()
    .from(sessionChapters)
    .where(eq(sessionChapters.sessionId, sessionId))
    .orderBy(asc(sessionChapters.chapterIndex));
  const lastChapter = chapters[chapters.length - 1] ?? null;
  const afterMsgId = lastChapter?.lastMsgId ?? null;

  const pending = await getNonOocMessagesAfter(sessionId, afterMsgId);

  let mode: ExtractorMode;
  let inputMessages: SessionMessage[];
  if (pending.length >= CHAPTER_SIZE) {
    mode = 'full';
    inputMessages = pending.slice(0, CHAPTER_SIZE);
  } else {
    mode = 'light';
    // Light mode reads the last 1–2 non-OOC messages — usually a player/master
    // pair, but the schema does not guarantee strict alternation (e.g. two
    // master messages in a row when a tool call splits narration). The
    // extractor prompt handles whichever shape it gets.
    inputMessages = pending.slice(-2);
  }
  if (inputMessages.length === 0) return null;

  const existingCodex = await db
    .select({
      kind: codexEntities.kind,
      slug: codexEntities.slug,
      name: codexEntities.name,
      data: codexEntities.data,
    })
    .from(codexEntities)
    .where(eq(codexEntities.sessionId, sessionId));

  return {
    sessionId,
    language: s.language,
    mode,
    inputMessages,
    existingCodex,
    previousChapters: chapters.map((c) => ({ chapterIndex: c.chapterIndex, summary: c.summary })),
    nextChapterIndex: chapters.length,
  };
}

interface RawPatch {
  upserts: CodexUpsert[];
  chapterSummary?: string;
}

function parseModelOutput(text: string): RawPatch | null {
  try {
    const cleaned = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const obj = JSON.parse(cleaned) as RawPatch;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.upserts)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Wipe existing memory and rebuild it from scratch by running extractMemory
 * sequentially until no more chapters can be produced from the message
 * history. Streams progress events. Idempotent: callers can re-trigger after
 * a partial failure.
 *
 * Lock semantics: this function briefly acquires the per-session advisory
 * lock to claim ownership, then unlocks before each extractMemory call (so
 * extractMemory can acquire it itself), then re-acquires after each call.
 * This prevents another concurrent extractor (e.g. a player turn arriving
 * mid-rebuild) from interleaving its own extraction with ours. */
export async function* rebuildMemoryStream(
  sessionId: string,
): AsyncGenerator<{ event: 'chapter_done' | 'complete' | 'error'; data: unknown }, void, unknown> {
  const acquired = await tryLock(sessionId);
  if (!acquired) {
    yield { event: 'error', data: { reason: 'locked' } };
    return;
  }
  try {
    // Wipe existing memory for this session.
    await db.delete(codexEntities).where(eq(codexEntities.sessionId, sessionId));
    await db.delete(sessionChapters).where(eq(sessionChapters.sessionId, sessionId));

    // Count total non-OOC messages → totalChapters.
    const allMsgs = await getNonOocMessagesAfter(sessionId, null);
    const totalChapters = Math.floor(allMsgs.length / CHAPTER_SIZE);

    for (let i = 0; i < totalChapters; i++) {
      // Release lock so extractMemory can acquire it itself.
      await unlock(sessionId);
      await extractMemory(sessionId);
      // Re-acquire ownership for the next iteration.
      const re = await tryLock(sessionId);
      if (!re) {
        yield { event: 'error', data: { reason: 'lock_lost' } };
        return;
      }
      yield { event: 'chapter_done', data: { index: i, total: totalChapters } };
    }
    yield { event: 'complete', data: { totalChapters } };
  } finally {
    await unlock(sessionId);
  }
}

export async function extractMemory(sessionId: string): Promise<void> {
  const acquired = await tryLock(sessionId);
  if (!acquired) return;
  try {
    const ctx = await buildContext(sessionId);
    if (!ctx) return;

    const sys = buildExtractorSystemPrompt(ctx.mode);
    const language = ctx.language ?? 'unknown';

    const userText = [
      `## Campaign language\n${language}`,
      `## Existing codex (compact)\n${formatExistingCodex(ctx.existingCodex)}`,
      ctx.mode === 'full'
        ? `## Previous chapters\n${formatPreviousChapters(ctx.previousChapters)}`
        : null,
      `## Messages to read\n${formatMessagesForExtractor(ctx.inputMessages)}`,
      ctx.mode === 'full'
        ? 'Produce upserts AND chapterSummary. JSON only.'
        : 'Produce upserts. JSON only.',
    ]
      .filter(Boolean)
      .join('\n\n');

    let response;
    try {
      response = await provider().completeMessage({
        model: process.env.MEMORY_EXTRACTOR_MODEL,
        systemBlocks: [{ type: 'text', text: sys }],
        messages: [{ role: 'user', content: userText }],
        tools: [],
        maxTokens: 2000,
        sessionId,
      });
    } catch (e) {
      console.error('extractor.provider_error', e instanceof Error ? e.message : String(e));
      return;
    }

    const text = response.contentBlocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const raw = parseModelOutput(text);
    if (!raw) {
      console.warn('extractor.bad_json', { sessionId, mode: ctx.mode, sample: text.slice(0, 200) });
      return;
    }

    const lastSeenMsgId = ctx.inputMessages[ctx.inputMessages.length - 1]!.id;
    const patch: MemoryPatch = { upserts: raw.upserts, lastSeenMsgId };
    if (ctx.mode === 'full') {
      if (typeof raw.chapterSummary === 'string' && raw.chapterSummary.length > 0) {
        patch.chapter = {
          chapterIndex: ctx.nextChapterIndex,
          firstMsgId: ctx.inputMessages[0]!.id,
          lastMsgId: lastSeenMsgId,
          messageCount: ctx.inputMessages.length,
          summary: raw.chapterSummary,
        };
      } else {
        console.warn('extractor.full_no_summary', {
          sessionId,
          chapterIndex: ctx.nextChapterIndex,
          messagesPending: ctx.inputMessages.length,
        });
      }
    }

    try {
      await applyPatch(sessionId, patch);
    } catch (e) {
      console.error('extractor.apply_failed', e instanceof Error ? e.message : String(e));
    }
  } finally {
    await unlock(sessionId);
  }
}
