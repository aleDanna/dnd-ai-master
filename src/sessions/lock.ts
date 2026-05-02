import { eq, and, lt, or, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';

export const TURN_LOCK_TTL_MS = 90_000;

/** Try to acquire the per-session turn lock. Returns true on success. */
export async function acquireTurnLock(sessionId: string): Promise<{ acquired: boolean; holder: string }> {
  const holder = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TURN_LOCK_TTL_MS);
  const result = await db
    .update(sessions)
    .set({ turnLockHolder: holder, turnLockExpiresAt: expires })
    .where(
      and(
        eq(sessions.id, sessionId),
        or(isNull(sessions.turnLockHolder), lt(sessions.turnLockExpiresAt, sql`now()`)),
      ),
    );
  const acquired = (result.rowCount ?? 0) > 0;
  return { acquired, holder };
}

export async function releaseTurnLock(sessionId: string, holder: string): Promise<void> {
  await db
    .update(sessions)
    .set({ turnLockHolder: null, turnLockExpiresAt: null })
    .where(and(eq(sessions.id, sessionId), eq(sessions.turnLockHolder, holder)));
}
