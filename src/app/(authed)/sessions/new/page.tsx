import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters } from '@/db/schema';
import { ensureUser } from '@/db/users';
import { NewSessionClient } from './new-client';

export const dynamic = 'force-dynamic';

export default async function NewSessionPage() {
  const { userId } = await auth();
  if (!userId) return null;
  await ensureUser(userId);

  const myChars = await db
    .select()
    .from(characters)
    .where(and(
      eq(characters.userId, userId),
      isNull(characters.deletedAt),
      isNull(characters.templateId),  // hide per-session instance forks
    ));

  return <NewSessionClient characters={myChars.map((c) => ({ id: c.id, name: c.name, raceSlug: c.raceSlug, classSlug: c.classSlug, level: c.level }))} />;
}
