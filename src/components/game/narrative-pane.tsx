'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { ToolPill } from './tool-pill';
import { SpinningDie } from './spinning-die';
import { TtsButton } from './tts-button';
import type { TurnEvent } from '@/sessions/types';
import type { MessageRow } from '@/sessions/client-types';

export interface NarrativeMessage {
  id?: string;
  role: 'master' | 'player' | 'system';
  content: string;
  tools?: { name: string; ok: boolean; error?: string; rolls: { formula: string; total: number }[] }[];
}

export interface NarrativePaneProps {
  sessionId: string;
  history: MessageRow[];
  liveEvents: TurnEvent[];
  busy: boolean;
  onSend: (text: string) => void;
  onCastSpell?: () => void;
}

export function NarrativePane({ sessionId, history, liveEvents, busy, onSend, onCastSpell }: NarrativePaneProps) {
  const [draft, setDraft] = React.useState('');
  const merged = mergeMessages(history, liveEvents);

  // Auto-scroll the page (not an internal pane) to the bottom when new content arrives.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [merged.length, busy, liveEvents.length]);

  const submit = (): void => {
    const t = draft.trim();
    if (!t || busy) return;
    onSend(t);
    setDraft('');
  };

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ flex: 1, padding: '32px 40px 16px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {merged.map((m, i) => <MessageView key={m.id ?? `live-${i}`} m={m} sessionId={sessionId} />)}
          {busy && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontSize: 16, fontStyle: 'italic' }}>
              <SpinningDie /> The Master is responding…
            </div>
          )}
        </div>
      </div>

      <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg-elev)', borderTop: '1px solid var(--border)', zIndex: 5 }}>
        <div style={{ padding: '10px 40px 0' }}>
          <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', gap: 6, paddingTop: 8, paddingBottom: 4, flexWrap: 'wrap' }}>
            <Quick icon="dice" label="Skill check" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I make a Perception check.')} />
            <Quick icon="sword" label="Attack" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I attack with my equipped weapon.')} />
            {onCastSpell && <Quick icon="spell" label="Cast spell" onClick={onCastSpell} />}
            <Quick icon="shield" label="Dodge" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I take the Dodge action.')} />
            <Quick icon="heart" label="Short rest" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'We take a short rest.')} />
            <div style={{ flex: 1 }} />
            <Quick icon="book" label="Look up rule" onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'Master, look up the rule for ')} />
          </div>
        </div>

        <div style={{ padding: '8px 40px 20px' }}>
        <div
          style={{
            maxWidth: 680,
            margin: '0 auto',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 12,
            padding: 8,
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="What do you do?"
            rows={2}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              color: 'var(--fg)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              lineHeight: 1.5,
              padding: '6px 8px',
            }}
          />
          <Button variant="primary" size="md" icon="send" disabled={busy || !draft.trim()} onClick={submit}>Send</Button>
        </div>
        <div style={{ maxWidth: 680, margin: '6px auto 0', fontSize: 11, color: 'var(--fg-subtle)', textAlign: 'center' }}>
          Enter to send · Shift+Enter for new line · Type in any language — the Master mirrors yours
        </div>
        </div>
      </div>
    </main>
  );
}

function Quick({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 999,
        color: 'var(--fg-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={13} /> {label}
    </button>
  );
}

function MessageView({ m, sessionId }: { m: NarrativeMessage; sessionId: string }) {
  if (m.role === 'master') {
    return (
      <div>
        <Eyebrow style={{ marginBottom: 6 }}>The Master</Eyebrow>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, lineHeight: 1.55, color: 'var(--fg)' }}>{m.content}</div>
        {(m.id || (m.tools && m.tools.length > 0)) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
            {m.id && <TtsButton sessionId={sessionId} messageId={m.id} />}
            {m.tools?.map((t, i) => (
              <ToolPill
                key={i}
                toolName={t.name}
                formula={t.rolls[0]?.formula}
                result={t.rolls[0] ? `${t.rolls[0].total}` : undefined}
                status={t.ok ? 'ok' : 'error'}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (m.role === 'player') {
    return (
      <div style={{ alignSelf: 'flex-end', marginLeft: 'auto', maxWidth: '85%' }}>
        <div style={{ background: 'var(--bone)', color: 'var(--ink)', borderRadius: '12px 12px 4px 12px', padding: '10px 14px', fontSize: 14, lineHeight: 1.5 }}>{m.content}</div>
      </div>
    );
  }
  return (
    <div
      style={{
        alignSelf: 'center',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'var(--bg-card)',
        border: '1px dashed var(--border-strong)',
        fontSize: 12,
        color: 'var(--fg-muted)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <Icon name="settings" size={12} /> {m.content}
    </div>
  );
}

function mergeMessages(history: MessageRow[], live: TurnEvent[]): NarrativeMessage[] {
  const out: NarrativeMessage[] = history.map((m) => ({ id: m.id, role: m.role, content: m.content }));
  // Append live events: build the in-progress master message from narrative_delta + tool_use_end events.
  let liveText = '';
  const liveTools: NonNullable<NarrativeMessage['tools']> = [];
  const pendingNames: Record<string, string> = {};
  for (const ev of live) {
    if (ev.type === 'narrative_delta') liveText += ev.text;
    else if (ev.type === 'tool_use_start') pendingNames[ev.toolUseId] = ev.name;
    else if (ev.type === 'tool_use_end') {
      const name = pendingNames[ev.toolUseId] ?? 'tool';
      liveTools.push({ name, ok: ev.ok, error: ev.error, rolls: ev.rolls.map((r) => ({ formula: r.formula, total: r.total })) });
    }
  }
  if (liveText || liveTools.length) {
    out.push({ role: 'master', content: liveText, tools: liveTools.length ? liveTools : undefined });
  }
  return out;
}
