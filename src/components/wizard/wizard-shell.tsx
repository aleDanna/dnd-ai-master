'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { StepBar } from '@/components/layout/step-bar';

export const WIZARD_STEPS = ['Race', 'Class', 'Class Choices', 'Background', 'Abilities', 'Skills', 'Feats', 'Equipment', 'Identity'] as const;
export type WizardStepName = typeof WIZARD_STEPS[number];

export interface WizardShellProps {
  current: number;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
  onCancel: () => void;
  showAi: boolean;
  onToggleAi: () => void;
  saveDisabled?: boolean;
  children: React.ReactNode;
  aiPane?: React.ReactNode;
}

export function WizardShell({
  current,
  onPrev,
  onNext,
  onSave,
  onCancel,
  showAi,
  onToggleAi,
  saveDisabled,
  children,
  aiPane,
}: WizardShellProps) {
  const last = current === WIZARD_STEPS.length - 1;
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 32px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onCancel}>Cancel</Button>
        <div style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 18 }}>
          New character
        </div>
        <Button variant="ghost" size="sm" icon="sparkle" onClick={onToggleAi}>{showAi ? 'Hide AI' : 'Show AI'}</Button>
      </header>
      <StepBar steps={[...WIZARD_STEPS]} current={current} />

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: showAi ? '1fr 380px' : '1fr', overflow: 'hidden' }}>
        <div style={{ overflowY: 'auto', padding: '32px 40px 100px' }}>
          <div style={{ maxWidth: 760, margin: '0 auto' }}>{children}</div>
        </div>
        {showAi && aiPane}
      </div>

      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '16px 32px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-elev)',
        }}
      >
        <Button variant="ghost" size="md" disabled={current === 0} onClick={onPrev} icon="arrow-left">Back</Button>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', alignSelf: 'center' }}>
          Step {current + 1} of {WIZARD_STEPS.length}
        </div>
        {last ? (
          <Button variant="accent" size="md" icon="check" onClick={onSave} disabled={saveDisabled}>Save character</Button>
        ) : (
          <Button variant="primary" size="md" iconRight="arrow-right" onClick={onNext}>
            Next: {WIZARD_STEPS[current + 1]}
          </Button>
        )}
      </footer>
    </div>
  );
}

export function StepHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <h2 style={{ fontSize: 28, fontWeight: 600, marginBottom: 6 }}>{title}</h2>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginBottom: 24, lineHeight: 1.55 }}>{sub}</p>
    </>
  );
}
