import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters as charactersTable } from '@/db/schema';
import { deriveCharacter } from './derive';
import type { WizardState } from './types';

export interface SaveCharacterInput {
  userId: string;
  wizard: WizardState;
}

export async function saveCharacter({ userId, wizard }: SaveCharacterInput): Promise<{ id: string }> {
  const derived = deriveCharacter(wizard);
  const [row] = await db
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
  return { id: row!.id };
}

export async function listMyCharacters(userId: string) {
  return db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.userId, userId), isNull(charactersTable.deletedAt)));
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
