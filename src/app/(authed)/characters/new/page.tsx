import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { loadOptions } from '@/characters/options';
import { WizardClient } from './wizard-client';

export const dynamic = 'force-dynamic';

export default async function NewCharacterPage() {
  const { userId } = await auth();
  if (!userId) return null;
  await ensureUser(userId);
  const options = await loadOptions();
  return <WizardClient options={options} />;
}
