import Link from 'next/link';
import { listSpells } from '@/srd/lookup';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const spells = await listSpells({ limit: 10, offset: 0 });
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>D&D AI Master — SRD smoke test</h1>
      <p>The first 10 spells in the seeded database:</p>
      <ul>
        {spells.map((s) => (
          <li key={s.slug}>
            <Link href={`/srd/spells/${s.slug}`}>
              {s.name} (lvl {s.level})
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
