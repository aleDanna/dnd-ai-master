import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { saveCharacter, listMyCharacters } from '@/characters/persist';
import { validateWizardState } from '@/characters/validate';
import { loadOptions } from '@/characters/options';
import type { WizardState } from '@/characters/types';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const characters = await listMyCharacters(userId);
  return NextResponse.json({ characters });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { wizard?: WizardState } | null;
  if (!body?.wizard) {
    return NextResponse.json({ error: 'missing-wizard' }, { status: 400 });
  }

  const options = await loadOptions();
  const v = validateWizardState(body.wizard, {
    raceSlugs: options.races.map((r) => r.slug),
    classSlugs: options.classes.map((c) => c.slug),
    backgroundSlugs: options.backgrounds.map((b) => b.slug),
  });
  if (!v.ok) {
    return NextResponse.json({ error: 'validation-failed', details: v.errors }, { status: 422 });
  }

  await ensureUser(userId);
  const { id } = await saveCharacter({ userId, wizard: body.wizard });
  return NextResponse.json({ id });
}
