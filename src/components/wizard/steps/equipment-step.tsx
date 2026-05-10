'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';
import { getStartingKit, resolveKitItems } from '@/srd/starting-kits';
import { getBackgroundEquipment } from '@/srd/starting-bg-equipment';

export interface EquipmentStepProps {
  classSlug: string | null;
  backgroundSlug: string | null;
  choice: 'kit' | 'gold';
  kitChoices: number[];
  onChoiceChange: (c: 'kit' | 'gold') => void;
  onKitChoiceChange: (index: number, option: number) => void;
}

export function EquipmentStep({
  classSlug,
  backgroundSlug,
  choice,
  kitChoices,
  onChoiceChange,
  onKitChoiceChange,
}: EquipmentStepProps) {
  const kit = getStartingKit(classSlug);
  const bgItems = getBackgroundEquipment(backgroundSlug);

  // Preview the resolved item list for the chosen kit + background.
  const previewItems = kit ? resolveKitItems(kit, kitChoices) : [];
  const allItems = [...previewItems, ...bgItems];

  return (
    <div>
      <StepHeader title="Equipment" sub="Pick a starting kit or roll for gold and shop later." />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        <Tile
          name="Class kit"
          note="Standard PHB starting kit. Pick options below; items go straight to your inventory."
          selected={choice === 'kit'}
          onClick={() => onChoiceChange('kit')}
          accent="var(--verdigris)"
        />
        <Tile
          name="Roll for gold"
          note="5d4 × 10 gp. Buy what you like at market price (resolved after creation)."
          selected={choice === 'gold'}
          onClick={() => onChoiceChange('gold')}
          accent="var(--verdigris)"
        />
      </div>

      {choice === 'kit' && kit && (
        <div style={{ marginBottom: 24 }}>
          {kit.choices.map((c, i) => {
            const selectedIdx = kitChoices[i] ?? 0;
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                <Eyebrow style={{ marginBottom: 8 }}>{c.label}</Eyebrow>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 8 }}>
                  {c.options.map((opt, j) => (
                    <Tile
                      key={j}
                      name={opt.label}
                      note={opt.items.map((it) => `${it.qty}× ${it.slug}`).join(', ')}
                      selected={selectedIdx === j}
                      onClick={() => onKitChoiceChange(i, j)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {choice === 'kit' && kit && (
        <div style={{ marginBottom: 16 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Inventory preview</Eyebrow>
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              fontSize: 13,
              color: 'var(--fg-muted)',
            }}
          >
            {allItems.length === 0
              ? 'No items yet — pick a class to see the kit.'
              : allItems.map((it) => `${it.qty}× ${it.slug}`).join(' · ')}
          </div>
        </div>
      )}

      {choice === 'kit' && !kit && (
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          Pick a class on the previous step to see its starting kit.
        </div>
      )}

      {choice === 'gold' && (
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          Your starting gold will be rolled and added to inventory after creation. The AI Master will help you spend it
          in the first scene.
        </div>
      )}
    </div>
  );
}
