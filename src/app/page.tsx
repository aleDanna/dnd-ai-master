import Link from 'next/link';
import { Icon } from '@/components/ui/icon';
import { Wordmark } from '@/components/ui/wordmark';
import { Chip } from '@/components/ui/chip';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';

const FEATURES = [
  { k: 'Deterministic engine', v: 'Every roll, every modifier, every save in a pure-TS engine. The AI calls tools — it never sums in its head.' },
  { k: 'Full audit trail', v: 'Every die, every tool call, every state mutation logged and inspectable. No black boxes.' },
  { k: 'Three campaign styles', v: 'Pre-written modules, fully improvised, or hybrid milestones — pick at creation, switch never.' },
  { k: 'Multilingual', v: "Master detects your language from the first messages and mirrors it for the rest of the campaign." },
];

const MODES = [
  { icon: 'user' as const, title: 'Solo', line: 'One player. One PC. The Master in your browser.', accent: 'var(--arcane)' },
  { icon: 'chat' as const, title: 'Local pass-and-play', line: 'Pass the laptop around the kitchen table.', accent: 'var(--ember)' },
  { icon: 'sparkle' as const, title: 'Remote room', line: 'Friends scattered. The dice still cluster.', accent: 'var(--gold)' },
];

export default function LandingPage() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(122,79,184,0.18), transparent 60%), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(215,51,28,0.12), transparent 60%)',
        }}
      />
      <header
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 48px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="logo-d20" size={28} />
          <Wordmark size={22} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Link href="/sign-in" style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Sign in</Link>
          <Link href="/hub"><Button variant="primary" size="sm">Open the table</Button></Link>
        </div>
      </header>

      <main style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px 24px' }}>
        <div style={{ maxWidth: 1080, width: '100%', display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 64, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <Chip tone="accent">D&amp;D 5e · AI Dungeon Master</Chip>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 72,
                fontWeight: 600,
                lineHeight: 1.0,
                letterSpacing: '-0.02em',
                margin: 0,
              }}
            >
              Roll the die.<br />
              <em style={{ color: 'var(--arcane-2)' }}>Let it tell.</em>
            </h1>
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 22, lineHeight: 1.5, color: 'var(--fg-muted)', maxWidth: 520 }}>
              A complete D&amp;D 5e table run by an AI Dungeon Master. Solo when you have an hour. Local pass-and-play around
              the kitchen table. Remote rooms when your friends are scattered across timezones.
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <Link href="/hub"><Button variant="primary" size="lg" iconRight="arrow-right">Open the table</Button></Link>
              <Button variant="secondary" size="lg" icon="book">Read the rules</Button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {MODES.map((m) => (
              <div
                key={m.title}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 18,
                  display: 'flex',
                  gap: 14,
                  alignItems: 'center',
                  boxShadow: 'var(--shadow-1)',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    background: `${m.accent}22`,
                    color: m.accent,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Icon name={m.icon} size={22} />
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, lineHeight: 1.1 }}>{m.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>{m.line}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <section style={{ position: 'relative', borderTop: '1px solid var(--border)', padding: '32px 48px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32 }}>
          {FEATURES.map((f) => (
            <div key={f.k}>
              <Eyebrow>{f.k}</Eyebrow>
              <p style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>{f.v}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
