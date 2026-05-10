'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Chip } from '@/components/ui/chip';
import { Button } from '@/components/ui/button';
import { TextArea } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import type { WizardState } from '@/characters/types';
import type { WizardStepName } from './wizard-shell';

const STEP_TO_KEY: Record<WizardStepName, 'race' | 'class' | 'class-choices' | 'background' | 'abilities' | 'skills' | 'feats' | 'equipment' | 'identity'> = {
  Race: 'race',
  Class: 'class',
  'Class Choices': 'class-choices',
  Background: 'background',
  Abilities: 'abilities',
  Skills: 'skills',
  Feats: 'feats',
  Equipment: 'equipment',
  Identity: 'identity',
};

export interface AiBuilderPaneProps {
  step: WizardStepName;
  wizard: WizardState;
  onAccept: (proposal: { step: string; value: unknown; reasoning: string }) => void;
}

export function AiBuilderPane({ step, wizard, onAccept }: AiBuilderPaneProps) {
  const [prompt, setPrompt] = React.useState('Wandering scout, raised in a port city, more comfortable with people than with the wild.');
  const [busy, setBusy] = React.useState(false);
  const [proposal, setProposal] = React.useState<{ step: string; value: unknown; reasoning: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function propose() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/wizard/ai-propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          step: STEP_TO_KEY[step],
          userPrompt: prompt,
          currentChoices: wizard,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Propose failed');
      }
      const body = (await res.json()) as { proposal: { step: string; value: unknown; reasoning: string } };
      setProposal(body.proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Propose failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      style={{
        borderLeft: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkle" size={18} style={{ color: 'var(--arcane)' }} />
        <Eyebrow>AI Builder · {step}</Eyebrow>
      </div>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
        Describe the character you have in mind. The Master will propose a value and explain it.
      </p>
      <TextArea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ fontSize: 13 }} />
      <Button variant="primary" size="sm" icon="sparkle" onClick={propose} disabled={busy}>
        {busy ? 'Thinking…' : 'Propose'}
      </Button>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--ember)' }}>{error}</div>
      )}

      {proposal && (
        <div
          style={{
            padding: 14,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <Chip tone="accent">Proposal · {String((proposal.value as { name?: string })?.name ?? proposal.value)}</Chip>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 15, lineHeight: 1.5, color: 'var(--fg)' }}>
            {proposal.reasoning}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => setProposal(null)}>Reject</Button>
            <Button variant="primary" size="sm" icon="check" onClick={() => { onAccept(proposal); setProposal(null); }}>Accept</Button>
          </div>
        </div>
      )}
    </aside>
  );
}
