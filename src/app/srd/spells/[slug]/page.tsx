import { notFound } from 'next/navigation';
import { lookupSpell } from '@/srd/lookup';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export default async function SpellPage({ params }: Props) {
  const { slug } = await params;
  const spell = await lookupSpell(slug);
  if (!spell) notFound();

  return (
    <main style={{ padding: '2rem', maxWidth: 720, fontFamily: 'system-ui, sans-serif' }}>
      <a href="/">← back</a>
      <h1>{spell.name}</h1>
      <p>
        <em>
          {spell.level === 0 ? `${spell.school} cantrip` : `Level ${spell.level} ${spell.school.toLowerCase()}`}
        </em>
      </p>
      <dl>
        <dt>Casting Time</dt><dd>{spell.castingTime}</dd>
        <dt>Range</dt><dd>{spell.range}</dd>
        <dt>Components</dt><dd>{spell.components}</dd>
        <dt>Duration</dt><dd>{spell.duration}{spell.concentration ? ' (concentration)' : ''}{spell.ritual ? ' (ritual)' : ''}</dd>
        <dt>Classes</dt><dd>{spell.classes.join(', ')}</dd>
        <dt>Source</dt><dd>{spell.source}</dd>
      </dl>
      <h2>Description</h2>
      <p>{spell.description}</p>
    </main>
  );
}
