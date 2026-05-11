'use client';
import * as React from 'react';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { ToolPill } from './tool-pill';
import { SpinningDie } from './spinning-die';
import { TtsButton } from './tts-button';
import { SceneImageButton } from './scene-image-button';
import { RollRequestGroup } from './roll-request-group';
import { MarkdownText } from './markdown-text';
import { formatResultText } from './roll-request-button';
import { parseRollRequests, pickAutoRoll, rollFormula } from '@/lib/roll-parser';
import { isOocMessage, stripOocPrefix } from '@/lib/ooc';
import type { TurnEvent } from '@/sessions/types';
import type { MessageRow } from '@/sessions/client-types';

export interface NarrativeMessage {
  id?: string;
  role: 'master' | 'player' | 'system';
  content: string;
  tools?: { name: string; ok: boolean; error?: string; rolls: { formula: string; total: number; rolls?: number[] }[] }[];
}

export interface NarrativePaneProps {
  sessionId: string;
  history: MessageRow[];
  liveEvents: TurnEvent[];
  busy: boolean;
  onSend: (text: string) => void;
  onCastSpell?: () => void;
  /** When true, master messages get inline roll buttons parsed from their text. */
  manualRolls: boolean;
  /** When true, master messages get a "Generate image" button next to Listen. Default false. */
  imageGenerationEnabled?: boolean;
  /** When true, the chat input and Send button are disabled (e.g. memory backfill in progress). */
  disabled?: boolean;
}

/** Number of newest messages visible on first load. The "Show previous"
 *  link reveals an additional batch of this size with each click. */
const PAGE_SIZE = 10;

export function NarrativePane({ sessionId, history, liveEvents, busy, onSend, onCastSpell, manualRolls, imageGenerationEnabled = false, disabled = false }: NarrativePaneProps) {
  const [draft, setDraft] = React.useState('');
  // Tamper-resistant pending roll. The text is set ONLY by handleRollResult
  // (called from the dice-button after the spinner settles) and rendered as
  // a read-only chip outside the textarea. The player cannot edit the rolled
  // number — they can only discard it (which clears state) or send it.
  const [pendingRollText, setPendingRollText] = React.useState<string | null>(null);
  // Ref-counted "any roll currently spinning" tracker. Disables the Send
  // button while a button is mid-roll so the player can't fire the
  // auto-roll-from-prose path on Enter and end up with a number that doesn't
  // match the one shown on the chip.
  const [rollingCount, setRollingCount] = React.useState(0);
  // Pagination: how many of the most recent messages to render. New messages
  // arriving from the master automatically extend the visible window (we
  // never want a fresh response to be hidden), but the user can click "Show
  // previous" to widen the window backwards into history.
  const [visibleCount, setVisibleCount] = React.useState<number>(PAGE_SIZE);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const merged = mergeMessages(history, liveEvents);
  const hiddenCount = Math.max(0, merged.length - visibleCount);
  const visibleMessages = hiddenCount > 0 ? merged.slice(hiddenCount) : merged;

  const loadPrevious = (): void => {
    setVisibleCount((c) => Math.min(c + PAGE_SIZE, merged.length));
  };

  // Auto-scroll the page (not an internal pane) to the bottom when new content
  // arrives. Re-runs on:
  //   - merged.length  : new persisted message landed
  //   - liveEvents.len : streaming chunk arrived
  //   - busy           : "The Master is responding…" appeared / disappeared
  //   - pendingRollText: chip appeared / disappeared (input bar height
  //     changes — without this dep, the last message can end up clipped
  //     behind the freshly-grown input bar)
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [merged.length, busy, liveEvents.length, pendingRollText]);

  const submit = (): void => {
    if (busy) return;
    // While any roll button is currently spinning, do not submit. The user
    // would otherwise race against the in-flight roll and trigger the
    // auto-roll-from-prose fallback, sending a different number than the one
    // about to land on the chip.
    if (rollingCount > 0) return;
    const prose = draft.trim();

    // Determine the roll result that will be attached to this message. Three
    // sources, in priority order:
    //
    // 1. Pending roll from a clicked button (held in `pendingRollText`,
    //    untouchable by the user).
    // 2. Auto-roll detection: the player's prose commits to one of the
    //    master's pending options (e.g. "intimidisco urlando" while an
    //    Intimidazione button is on offer). We compute the roll here and
    //    keep the result string LOCAL — never round-trips through React
    //    state that the player could read back.
    //
    // Both cases produce a single read-only string we splice onto the
    // outgoing message. There is no path where a player-controlled text
    // ends up driving the rolled number.
    let rollResultText: string | null = pendingRollText;
    if (!rollResultText && manualRolls && prose) {
      const lastMaster = [...merged].reverse().find((m) => m.role === 'master' && m.content);
      if (lastMaster) {
        const reqs = parseRollRequests(lastMaster.content);
        const matched = pickAutoRoll(prose, reqs, lastMaster.content);
        if (matched) {
          const rolled = rollFormula(matched.formula);
          rollResultText = formatResultText(matched, rolled);
        }
      }
    }

    let outgoing: string;
    if (prose && rollResultText) {
      outgoing = `${prose}\n${rollResultText}`;
    } else if (rollResultText) {
      outgoing = rollResultText;
    } else if (prose) {
      outgoing = prose;
    } else {
      return; // nothing to send
    }

    onSend(outgoing);
    setDraft('');
    setPendingRollText(null);
  };

  /**
   * Handler invoked by RollRequestGroup when one or more dice settle. The
   * formatted result string lands in a dedicated piece of state and is
   * rendered as a read-only chip above the textarea. The textarea itself
   * is reserved for the player's free prose.
   *
   * Critical: this string is the SOURCE OF TRUTH for the rolled number that
   * will be sent. It must never be merged into the player-editable draft —
   * doing so would let the player rewrite the number ("rolled a 3" → "rolled
   * a 17") before pressing Send. The chip exposes only a discard button.
   */
  const handleRollResult = (text: string): void => {
    setPendingRollText(text);
    // Move focus to the textarea so the player can immediately add context.
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }, 0);
  };

  const handleRollStart = (): void => setRollingCount((c) => c + 1);
  const handleRollEnd = (): void => setRollingCount((c) => Math.max(0, c - 1));

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Bottom padding is generous so the last message clears the sticky
          input bar with room to spare (the bar can grow when a chip lands).
          The sticky bar itself takes space in normal flow, but its shadow /
          border can still feel cramped without breathing room. */}
      <div style={{ flex: 1, padding: '32px 40px 80px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={loadPrevious}
              aria-label={`Show previous ${Math.min(PAGE_SIZE, hiddenCount)} messages`}
              style={{
                alignSelf: 'center',
                padding: '6px 14px',
                background: 'transparent',
                border: '1px dashed var(--border-strong)',
                borderRadius: 999,
                color: 'var(--fg-muted)',
                fontFamily: 'var(--font-ui)',
                fontSize: 12,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              ↑ Show previous {Math.min(PAGE_SIZE, hiddenCount)}
              {hiddenCount > PAGE_SIZE && (
                <span style={{ color: 'var(--fg-subtle)' }}>· {hiddenCount} hidden</span>
              )}
            </button>
          )}
          {visibleMessages.map((m, i) => (
            <MessageView
              key={m.id ?? `live-${i}`}
              m={m}
              sessionId={sessionId}
              manualRolls={manualRolls}
              imageGenerationEnabled={imageGenerationEnabled}
              onRollResult={handleRollResult}
              onAnyRollStart={handleRollStart}
              onAnyRollEnd={handleRollEnd}
            />
          ))}
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
            flexDirection: 'column',
            gap: 6,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 12,
            padding: 8,
          }}
        >
          {pendingRollText && <PendingRollChip text={pendingRollText} />}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={disabled}
              placeholder={disabled ? 'Preparazione memoria in corso…' : 'What do you do? · Start with ! to ask the master out-of-character'}
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
                opacity: disabled ? 0.4 : undefined,
              }}
            />
            <Button
              variant="primary"
              size="md"
              icon="send"
              disabled={disabled || busy || rollingCount > 0 || (!draft.trim() && !pendingRollText)}
              onClick={submit}
            >
              Send
            </Button>
          </div>
        </div>
        <div style={{ maxWidth: 680, margin: '6px auto 0', fontSize: 11, color: 'var(--fg-subtle)', textAlign: 'center' }}>
          Enter to send · Shift+Enter for new line · Rolls show as a chip — add context, then send
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

/**
 * Read-only chip that shows the rolled result that will be attached to the
 * outgoing message. The displayed text is bound to `text` via React state
 * and has no editable surface AND no discard button: once the dice are
 * rolled, the result is committed — the player cannot back out and "re-roll"
 * by waiting for the next opportunity. This is the tamper-resistant
 * counterpart to the editable textarea: the rolled number can be seen and
 * sent, but never re-typed and never thrown away.
 */
function PendingRollChip({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        padding: '4px 12px',
        borderRadius: 999,
        background: 'rgba(122, 79, 184, 0.15)',
        border: '1px solid var(--arcane)',
        color: 'var(--fg)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        maxWidth: '100%',
      }}
      role="status"
      aria-label="Pending dice roll"
    >
      <Icon name="dice" size={13} />
      <span style={{ whiteSpace: 'pre-wrap' }}>
        <MarkdownText text={text} />
      </span>
    </div>
  );
}

function MessageView({
  m,
  sessionId,
  manualRolls,
  imageGenerationEnabled,
  onRollResult,
  onAnyRollStart,
  onAnyRollEnd,
}: {
  m: NarrativeMessage;
  sessionId: string;
  manualRolls: boolean;
  imageGenerationEnabled: boolean;
  onRollResult: (text: string) => void;
  onAnyRollStart?: () => void;
  onAnyRollEnd?: () => void;
}) {
  if (m.role === 'master') {
    const rollRequests = manualRolls ? parseRollRequests(m.content) : [];
    const hasFooter = m.id || (m.tools && m.tools.length > 0) || rollRequests.length > 0;
    return (
      <div>
        <Eyebrow style={{ marginBottom: 6 }}>The Master</Eyebrow>
        <MarkdownText
          text={m.content}
          style={{ fontFamily: 'var(--font-display)', fontSize: 18, lineHeight: 1.55, color: 'var(--fg)' }}
        />
        {hasFooter && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
            {m.id && <TtsButton sessionId={sessionId} messageId={m.id} />}
            {m.id && imageGenerationEnabled && (
              <SceneImageButton sessionId={sessionId} messageId={m.id} />
            )}
            {rollRequests.length > 0 && (
              <RollRequestGroup
                key={`${m.id ?? 'live'}-roll-group`}
                requests={rollRequests}
                onSend={onRollResult}
                onAnyRollStart={onAnyRollStart}
                onAnyRollEnd={onAnyRollEnd}
              />
            )}
            {m.tools?.map((t, i) => {
              const r = t.rolls[0];
              // Transparency: show the raw die rolls so the player can audit the
              // total. "1d20+5 [13] → 18" makes it clear the engine rolled 13 on
              // the d20 and added the +5 modifier. "1d20+5 [8,15] ADV → 20" shows
              // both dice rolled with advantage (the engine picked 15, the max).
              let formula = r?.formula;
              if (r?.rolls && r.rolls.length > 0) {
                const adv = r.rolls.length === 2;
                const list = `[${r.rolls.join(',')}]${adv ? ' ADV/DIS' : ''}`;
                formula = formula ? `${formula} ${list}` : list;
              }
              return (
                <ToolPill
                  key={i}
                  toolName={t.name}
                  formula={formula}
                  result={r ? `${r.total}` : undefined}
                  status={t.ok ? 'ok' : 'error'}
                />
              );
            })}
          </div>
        )}
      </div>
    );
  }
  if (m.role === 'player') {
    const ooc = isOocMessage(m.content);
    const displayText = ooc ? stripOocPrefix(m.content) : m.content;
    return (
      <div style={{ alignSelf: 'flex-end', marginLeft: 'auto', maxWidth: '85%' }}>
        {ooc && (
          <div
            style={{
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--fg-subtle)',
              textAlign: 'right',
              marginBottom: 4,
              fontFamily: 'var(--font-ui)',
            }}
          >
            Aside · OOC
          </div>
        )}
        <div
          style={{
            background: ooc ? 'transparent' : 'var(--bone)',
            color: ooc ? 'var(--fg-muted)' : 'var(--ink)',
            border: ooc ? '1px dashed var(--border-strong)' : 'none',
            borderRadius: '12px 12px 4px 12px',
            padding: '10px 14px',
            fontSize: 14,
            lineHeight: 1.5,
            fontStyle: ooc ? 'italic' : 'normal',
          }}
        >
          <MarkdownText text={displayText} />
        </div>
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
      liveTools.push({ name, ok: ev.ok, error: ev.error, rolls: ev.rolls.map((r) => ({ formula: r.formula, total: r.total, rolls: r.rolls })) });
    }
  }
  if (liveText || liveTools.length) {
    out.push({ role: 'master', content: liveText, tools: liveTools.length ? liveTools : undefined });
  }
  return out;
}
