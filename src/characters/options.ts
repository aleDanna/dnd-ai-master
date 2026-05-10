import { listClasses, listRaces, listBackgrounds, listFeats } from '@/srd/lookup';

export async function loadOptions() {
  const [races, classes, backgrounds, feats] = await Promise.all([
    listRaces(),
    listClasses(),
    listBackgrounds(),
    listFeats(),
  ]);
  return { races, classes, backgrounds, feats };
}

export type Options = Awaited<ReturnType<typeof loadOptions>>;
