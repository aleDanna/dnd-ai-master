import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import {
  getUserPreferences,
  updateUserPreferences,
  isValidTtsVoice,
  type UserPreferences,
} from '@/lib/preferences';
import { isKnownProvider, isKnownMasterModel } from '@/lib/ai-models';
import { isMasterGuidanceLevel, isImageStylePreset } from '@/db/schema/users';

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
  if ('manualRolls' in body) {
    if (typeof body.manualRolls !== 'boolean') {
      return NextResponse.json({ error: 'invalid-manualRolls' }, { status: 400 });
    }
    patch.manualRolls = body.manualRolls;
  }
  if ('aiProvider' in body) {
    if (!isKnownProvider(body.aiProvider)) {
      return NextResponse.json({ error: 'invalid-aiProvider' }, { status: 400 });
    }
    patch.aiProvider = body.aiProvider;
  }
  if ('aiMasterModel' in body) {
    if (body.aiMasterModel !== undefined && !isKnownMasterModel(body.aiMasterModel)) {
      return NextResponse.json({ error: 'invalid-aiMasterModel' }, { status: 400 });
    }
    patch.aiMasterModel = body.aiMasterModel as string | undefined;
  }
  if ('masterGuidanceLevel' in body) {
    if (!isMasterGuidanceLevel(body.masterGuidanceLevel)) {
      return NextResponse.json({ error: 'invalid-masterGuidanceLevel' }, { status: 400 });
    }
    patch.masterGuidanceLevel = body.masterGuidanceLevel;
  }
  if ('showDifficultyNumbers' in body) {
    if (typeof body.showDifficultyNumbers !== 'boolean') {
      return NextResponse.json({ error: 'invalid-showDifficultyNumbers' }, { status: 400 });
    }
    patch.showDifficultyNumbers = body.showDifficultyNumbers;
  }
  if ('imageGenerationEnabled' in body) {
    if (typeof body.imageGenerationEnabled !== 'boolean') {
      return NextResponse.json({ error: 'invalid-imageGenerationEnabled' }, { status: 400 });
    }
    patch.imageGenerationEnabled = body.imageGenerationEnabled;
  }
  if ('imageStylePreset' in body) {
    if (!isImageStylePreset(body.imageStylePreset)) {
      return NextResponse.json({ error: 'invalid-imageStylePreset' }, { status: 400 });
    }
    patch.imageStylePreset = body.imageStylePreset;
  }
  if ('imageStyleCustom' in body) {
    if (typeof body.imageStyleCustom !== 'string') {
      return NextResponse.json({ error: 'invalid-imageStyleCustom' }, { status: 400 });
    }
    if (body.imageStyleCustom.length > 500) {
      return NextResponse.json({ error: 'imageStyleCustom-too-long' }, { status: 400 });
    }
    patch.imageStyleCustom = body.imageStyleCustom;
  }

  const updated = await updateUserPreferences(userId, patch);
  return NextResponse.json({ preferences: updated });
}
