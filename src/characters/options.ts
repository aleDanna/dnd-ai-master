import { listClasses, listRaces, listBackgrounds } from '@/srd/lookup';

export async function loadOptions() {
  const [races, classes, backgrounds] = await Promise.all([
    listRaces(),
    listClasses(),
    listBackgrounds(),
  ]);
  return { races, classes, backgrounds };
}

export type Options = Awaited<ReturnType<typeof loadOptions>>;
