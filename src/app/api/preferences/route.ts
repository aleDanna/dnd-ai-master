import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { getUserPreferences, updateUserPreferences, type UserPreferences } from '@/lib/preferences';

const ALLOWED_KEYS = new Set(['ttsAutoplay']);

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);
  const prefs = await getUserPreferences(userId);
  return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 });
  }

  // Reject any non-allowed keys up front — surfaces stale clients that
  // still try to PUT campaign-scoped settings here.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      return NextResponse.json({ error: 'unknown-key', key }, { status: 400 });
    }
  }

  const patch: Partial<UserPreferences> = {};
  if ('ttsAutoplay' in body) {
    if (typeof body.ttsAutoplay !== 'boolean') {
      return NextResponse.json({ error: 'invalid-ttsAutoplay' }, { status: 400 });
    }
    patch.ttsAutoplay = body.ttsAutoplay;
  }

  const updated = await updateUserPreferences(userId, patch);
  return NextResponse.json({ preferences: updated });
}
