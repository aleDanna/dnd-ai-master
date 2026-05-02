import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import {
  getUserPreferences,
  updateUserPreferences,
  isValidTtsVoice,
  type UserPreferences,
} from '@/lib/preferences';

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

  const body = (await req.json().catch(() => null)) as Partial<UserPreferences> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 });
  }

  const patch: Partial<UserPreferences> = {};
  if ('ttsVoice' in body) {
    if (body.ttsVoice === undefined || body.ttsVoice === null) {
      // Caller wants to reset to default — drop the key
      patch.ttsVoice = undefined;
    } else if (!isValidTtsVoice(body.ttsVoice)) {
      return NextResponse.json({ error: 'invalid-ttsVoice' }, { status: 400 });
    } else {
      patch.ttsVoice = body.ttsVoice;
    }
  }
  if ('ttsAutoplay' in body) {
    if (typeof body.ttsAutoplay !== 'boolean') {
      return NextResponse.json({ error: 'invalid-ttsAutoplay' }, { status: 400 });
    }
    patch.ttsAutoplay = body.ttsAutoplay;
  }

  const updated = await updateUserPreferences(userId, patch);
  return NextResponse.json({ preferences: updated });
}
