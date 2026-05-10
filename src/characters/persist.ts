import { eq, and, isNull, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  characters as charactersTable,
  srdBackground as backgroundsTable,
  srdRace as racesTable,
  srdClass as classesTable,
  srdFeat as featsTable,
} from '@/db/schema';
import type { SrdBackground, SrdRace, SrdClass, SrdFeat } from '@/db/schema';
import { deriveCharacter } from './derive';
import type { WizardState } from './types';

export interface SaveCharacterInput {
  userId: string;
  wizard: WizardState;
}

export async function saveCharacter({ userId, wizard }: SaveCharacterInput): Promise<{ id: string }> {
  let background: SrdBackground | undefined = undefined;
  let race: SrdRace | undefined = undefined;
  let parentRace: SrdRace | undefined = undefined;
  let klass: SrdClass | undefined = undefined;

  if (wizard.backgroundSlug) {
    const [bgRow] = await db.select().from(backgroundsTable).where(eq(backgroundsTable.slug, wizard.backgroundSlug)).limit(1);
    background = bgRow;
  }
  // Resolve the effective race row: subrace if the player picked one, base otherwise.
  // When a subrace is selected, also load its parent so racial ASI/languages/traits stack.
  const effectiveRaceSlug = wizard.subraceSlug ?? wizard.raceSlug;
  if (effectiveRaceSlug) {
    const [raceRow] = await db.select().from(racesTable).where(eq(racesTable.slug, effectiveRaceSlug)).limit(1);
    race = raceRow;
    if (race?.parentRaceSlug) {
      const [parentRow] = await db.select().from(racesTable).where(eq(racesTable.slug, race.parentRaceSlug)).limit(1);
      parentRace = parentRow;
    }
  }
  if (wizard.classSlug) {
    const [classRow] = await db.select().from(classesTable).where(eq(classesTable.slug, wizard.classSlug)).limit(1);
    klass = classRow;
  }
  let feats: SrdFeat[] = [];
  if (wizard.feats && wizard.feats.length > 0) {
    feats = await db.select().from(featsTable).where(inArray(featsTable.slug, wizard.feats));
  }

  const derived = deriveCharacter(wizard, { background, race, parentRace, klass, feats });
  const [inserted] = await db
    .insert(charactersTable)
    .values({
      userId,
      name: derived.name,
      level: derived.level,
      raceSlug: derived.raceSlug,
      classSlug: derived.classSlug,
      backgroundSlug: derived.backgroundSlug,
      abilities: derived.abilities,
      proficiencyBonus: derived.proficiencyBonus,
      hpMax: derived.hpMax,
      ac: derived.ac,
      speed: derived.speed,
      proficiencies: derived.proficiencies,
      spellcasting: derived.spellcasting,
      spellsKnown: [],
      features: derived.features,
      inventory: derived.inventory,
      identity: {
        alignment: wizard.identity.alignment,
        trait: wizard.identity.trait,
        bond: wizard.identity.bond,
        flaw: wizard.identity.flaw,
        backstory: wizard.identity.backstory,
        portraitColor: wizard.identity.portraitColor,
      },
      hitDiceMax: derived.hitDiceMax,
      hitDieSize: derived.hitDieSize,
    })
    .returning({ id: charactersTable.id });
  return { id: inserted!.id };
}

export async function listMyCharacters(userId: string) {
  return db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.userId, userId),
      isNull(charactersTable.deletedAt),
      isNull(charactersTable.templateId),  // hide per-session instance forks
    ));
}

export async function getMyCharacter(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, userId), isNull(charactersTable.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function softDeleteCharacter(userId: string, id: string): Promise<boolean> {
  const result = await db
    .update(charactersTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, userId), isNull(charactersTable.deletedAt)));
  return (result.rowCount ?? 0) > 0;
}
