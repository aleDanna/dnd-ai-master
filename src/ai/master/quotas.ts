import { eq, and, gte, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiUsage, sessions } from '@/db/schema';

export const DAILY_TURN_CAP = Number(process.env.DAILY_TURN_CAP ?? '200');
export const SESSION_COUNT_CAP = Number(process.env.SESSION_COUNT_CAP ?? '50');

export type QuotaResult = { ok: true } | { ok: false; reason: 'daily_turn_cap' | 'session_count_cap' };

export interface CheckQuotasInput {
  userId: string;
  kind?: 'turn' | 'create_session';
}

export async function checkQuotas(input: CheckQuotasInput): Promise<QuotaResult> {
  const kind = input.kind ?? 'turn';

  if (kind === 'create_session') {
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.userId, input.userId), isNull(sessions.deletedAt)));
    if ((count?.n ?? 0) >= SESSION_COUNT_CAP) return { ok: false, reason: 'session_count_cap' };
    return { ok: true };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, input.userId), eq(aiUsage.endpoint, 'master'), gte(aiUsage.createdAt, since)));
  if ((count?.n ?? 0) >= DAILY_TURN_CAP) return { ok: false, reason: 'daily_turn_cap' };
  return { ok: true };
}
