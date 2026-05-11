import { eq, and, asc, gt, or, sql, lt, isNull } from 'drizzle-orm';
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
import { getMasterProvider, getProviderByName, type ProviderName } from '@/ai/provider';
import type { MasterProvider } from '@/ai/provider/types';

const CHAPTER_SIZE = 40;

let _override: MasterProvider | null = null;
/** Test-only seam. */
export function __setExtractorProviderForTest(p: MasterProvider | null): void {
  _override = p;
}

function provider(name?: ProviderName): MasterProvider {
  if (_override) return _override;
  return name ? getProviderByName(name) : getMasterProvider();
}

/** Memory-lock TTL. Each successful acquire/renew sets the expiry this far in
 * the future; if the holder crashes without releasing, the lock auto-expires. */
const MEMORY_LOCK_TTL_MS = 10 * 60 * 1000;

/** Try to claim the per-session memory lock. Returns the holder token on
 * success, or null if another holder still owns a non-expired lock.
 *
 * We use a row-based lock (a column on `sessions`) instead of Postgres
 * advisory locks because deployments sit behind PgBouncer in transaction-
 * pooling mode, where advisory locks live on the underlying server connection
 * and survive across rotations — leaking permanently. Row locks are
 * transactional and survive the pooler safely. */
async function tryAcquireMemoryLock(sessionId: string): Promise<string | null> {
  const holder = crypto.randomUUID();
  const expires = new Date(Date.now() + MEMORY_LOCK_TTL_MS);
  const r = await db
    .update(sessions)
    .set({ memoryLockHolder: holder, memoryLockExpiresAt: expires })
    .where(
      and(
        eq(sessions.id, sessionId),
        or(isNull(sessions.memoryLockHolder), lt(sessions.memoryLockExpiresAt, sql`now()`)),
      ),
    );
  return (r.rowCount ?? 0) > 0 ? holder : null;
}

/** Extend the lock TTL while holding it. No-op if we no longer own it. */
async function renewMemoryLock(sessionId: string, holder: string): Promise<boolean> {
  const expires = new Date(Date.now() + MEMORY_LOCK_TTL_MS);
  const r = await db
    .update(sessions)
    .set({ memoryLockExpiresAt: expires })
    .where(and(eq(sessions.id, sessionId), eq(sessions.memoryLockHolder, holder)));
  return (r.rowCount ?? 0) > 0;
}

async function releaseMemoryLock(sessionId: string, holder: string): Promise<void> {
  await db
    .update(sessions)
    .set({ memoryLockHolder: null, memoryLockExpiresAt: null })
    .where(and(eq(sessions.id, sessionId), eq(sessions.memoryLockHolder, holder)));
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
          sql`left(trim(${sessionMessages.content}), 1) <> '!'`,
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
          sql`left(trim(${sessionMessages.content}), 1) <> '!'`,
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
        sql`left(trim(${sessionMessages.content}), 1) <> '!'`,
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

/** Wipe existing memory and rebuild it from scratch by running the extractor
 * sequentially until no more chapters can be produced from the message
 * history. Streams progress events. Idempotent: callers can re-trigger after
 * a partial failure.
 *
 * Lock semantics: holds the per-session advisory lock for the entire rebuild.
 * Concurrent `extractMemory` calls (e.g. a player turn arriving mid-rebuild)
 * will see `tryLock` fail and skip — desired behavior. */
export async function* rebuildMemoryStream(
  sessionId: string,
  providerName?: ProviderName,
): AsyncGenerator<{ event: 'chapter_done' | 'complete' | 'error'; data: unknown }, void, unknown> {
  const holder = await tryAcquireMemoryLock(sessionId);
  if (!holder) {
    yield { event: 'error', data: { reason: 'locked' } };
    return;
  }
  try {
    await db.delete(codexEntities).where(eq(codexEntities.sessionId, sessionId));
    await db.delete(sessionChapters).where(eq(sessionChapters.sessionId, sessionId));

    const allMsgs = await getNonOocMessagesAfter(sessionId, null);
    const totalChapters = Math.floor(allMsgs.length / CHAPTER_SIZE);

    for (let i = 0; i < totalChapters; i++) {
      // Renew TTL each iteration so a long rebuild can't time itself out
      // mid-run. If we lost the lock (another process took it after expiry),
      // bail out instead of silently overwriting.
      if (!(await renewMemoryLock(sessionId, holder))) {
        yield { event: 'error', data: { reason: 'lock_lost' } };
        return;
      }
      await runExtraction(sessionId, providerName);
      yield { event: 'chapter_done', data: { index: i, total: totalChapters } };
    }
    yield { event: 'complete', data: { totalChapters } };
  } finally {
    await releaseMemoryLock(sessionId, holder);
  }
}

/** Run a single extractor pass for `sessionId`. The optional `providerName`
 * forces the call to use the user's preferred AI provider — without it the
 * extractor falls back to the env-level MASTER_PROVIDER, which on this
 * deployment defaults to Anthropic and surfaces as "ANTHROPIC_API_KEY not set"
 * for users on OpenAI/Gemini. The turn route passes it through. */
export async function extractMemory(sessionId: string, providerName?: ProviderName): Promise<void> {
  const holder = await tryAcquireMemoryLock(sessionId);
  if (!holder) return;
  try {
    await runExtraction(sessionId, providerName);
  } finally {
    await releaseMemoryLock(sessionId, holder);
  }
}

async function runExtraction(sessionId: string, providerName?: ProviderName): Promise<void> {
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
    response = await provider(providerName).completeMessage({
      model: process.env.MEMORY_EXTRACTOR_MODEL,
      systemBlocks: [{ type: 'text', text: sys }],
      messages: [{ role: 'user', content: userText }],
      tools: [],
      // 8192 gives Gemini 2.5 enough room to think AND produce the JSON.
      // The extractor output is bounded (~1500 tokens for a typical chapter
      // with upserts + summary); the extra headroom is for Gemini's internal
      // reasoning pass.
      maxTokens: 8192,
      sessionId,
      // Cap Gemini thinking so it can't eat the entire output budget on a
      // complex chapter. 1024 tokens of reasoning is plenty for structured
      // JSON extraction, and leaves ~7K for the actual JSON payload.
      // No-op on Anthropic/OpenAI. Observed live: rebuild was stuck because
      // thinking consumed all 2000 tokens of the older maxTokens budget,
      // and the response came back with zero content blocks.
      geminiThinkingBudget: 1024,
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
    // Distinguish "empty response" (provider returned nothing — typically
    // Gemini's safety filter on D&D combat scenes) from "non-JSON" (model
    // wrote prose around the JSON). The provider-side warn now logs the
    // finishReason when relevant; this complements it with the extractor's
    // own context (mode, sample).
    console.warn('extractor.bad_json', {
      sessionId,
      mode: ctx.mode,
      sample: text.slice(0, 200),
      contentBlockCount: response.contentBlocks.length,
      stopReason: response.stopReason,
      empty: text.length === 0,
    });
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
}
