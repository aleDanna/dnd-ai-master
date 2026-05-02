import { eq } from 'drizzle-orm';
import { db } from './client';
import { users } from './schema';

export async function ensureUser(userId: string, displayName?: string | null): Promise<void> {
  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (existing) return;
  await db.insert(users).values({ id: userId, displayName: displayName ?? null }).onConflictDoNothing();
}
