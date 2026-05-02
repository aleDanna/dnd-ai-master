import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { proposeOne, type ProposeInput } from '@/ai/wizard/loop';
import { loadOptions } from '@/characters/options';
import { validateProposal } from '@/ai/wizard/validate-proposal';
import { getResolvedPreferences } from '@/lib/preferences';

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });

  const body = (await req.json().catch(() => null)) as Partial<ProposeInput> | null;
  if (!body?.step || !body.userPrompt) {
    return new Response(JSON.stringify({ error: 'missing-fields' }), { status: 400 });
  }

  const options = await loadOptions();
  const srdContext = buildSrdContext(body.step, options);
  const userPrefs = await getResolvedPreferences(userId);

  try {
    const proposal = await proposeOne({
      step: body.step as ProposeInput['step'],
      userPrompt: body.userPrompt,
      srdContext,
      currentChoices: body.currentChoices ?? {},
      userId,
      provider: userPrefs.aiProvider,
      model: userPrefs.aiMasterModel,
    });
    const validation = validateProposal(proposal, {
      raceSlugs: options.races.map((r) => r.slug),
      classSlugs: options.classes.map((c) => c.slug),
      backgroundSlugs: options.backgrounds.map((b) => b.slug),
    });
    if (!validation.ok) {
      return new Response(JSON.stringify({ error: 'invalid_proposal', detail: validation.error, proposal }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ proposal }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
    });
  }
}

function buildSrdContext(step: string, opts: Awaited<ReturnType<typeof loadOptions>>): string {
  switch (step) {
    case 'race':
      return opts.races.map((r) => `- ${r.slug}: ${r.name}`).join('\n');
    case 'class':
      return opts.classes.map((c) => `- ${c.slug}: ${c.name} (${c.hitDie}, ${c.savingThrows.join('/')})`).join('\n');
    case 'background':
      return opts.backgrounds.map((b) => `- ${b.slug}: ${b.name} — ${b.skillProficiencies.join(', ')}`).join('\n');
    default:
      return '(no extra SRD context for this step)';
  }
}
