// Landing page — reframed to mention all three modes
const LandingScreen = ({ onStart }) => (
  <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
    {/* ambient backdrop */}
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(122,79,184,0.18), transparent 60%), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(215,51,28,0.12), transparent 60%)" }}/>

    <header style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 48px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="logo-d20" size={28}/>
        <Wordmark size={22}/>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <a style={{ fontSize: 13, color: "var(--fg-muted)", marginRight: 16 }}>How it works</a>
        <a style={{ fontSize: 13, color: "var(--fg-muted)", marginRight: 16 }}>Pricing</a>
        <Button variant="ghost" size="sm">Sign in</Button>
        <Button variant="primary" size="sm" onClick={onStart}>Open the table</Button>
      </div>
    </header>

    <main style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "64px 24px" }}>
      <div style={{ maxWidth: 1080, width: "100%", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 64, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <Chip tone="accent">D&amp;D 5e · AI Dungeon Master</Chip>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 72, fontWeight: 600, lineHeight: 1.0, letterSpacing: "-0.02em", margin: 0, textWrap: "balance" }}>
            Roll the die.<br/><em style={{ color: "var(--arcane-2)" }}>Let it tell.</em>
          </h1>
          <p style={{ fontFamily: "var(--font-display)", fontSize: 22, lineHeight: 1.5, color: "var(--fg-muted)", maxWidth: 520, margin: 0 }}>
            A complete D&amp;D 5e table run by an AI Dungeon Master. Solo when you have an hour. Local pass-and-play around the kitchen table. Remote rooms when your friends are scattered across timezones. The Master mirrors your language, narrates vividly, and never invents a stat block.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <Button variant="primary" size="lg" iconRight="arrow-right" onClick={onStart}>Open the table</Button>
            <Button variant="secondary" size="lg" icon="book">Read the rules</Button>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--fg-subtle)", fontStyle: "italic", fontFamily: "var(--font-display)" }}>Tira il dado. Lascia che racconti. · Made in Italy, played anywhere.</div>
        </div>

        {/* Mode preview cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ModeTile icon="user" title="Solo" line="One player. One PC. The Master in your browser." accent="var(--arcane)"/>
          <ModeTile icon="chat" title="Local pass-and-play" line="Pass the laptop around the kitchen table." accent="var(--ember)"/>
          <ModeTile icon="sparkle" title="Remote room" line="Friends scattered. The dice still cluster." accent="var(--gold)"/>
        </div>
      </div>
    </main>

    <section style={{ position: "relative", borderTop: "1px solid var(--border)", padding: "32px 48px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32 }}>
        {[
          { k: "Deterministic engine", v: "Every roll, every modifier, every save in a pure-TS engine. The AI calls tools — it never sums in its head." },
          { k: "Full audit trail", v: "Every die, every tool call, every state mutation logged and inspectable. No black boxes." },
          { k: "Three campaign styles", v: "Pre-written modules, fully improvised, or hybrid milestones — pick at creation, switch never." },
          { k: "Multilingual", v: "Master detects your language from the first messages and mirrors it for the rest of the campaign." },
        ].map(f => (
          <div key={f.k}>
            <Eyebrow>{f.k}</Eyebrow>
            <p style={{ marginTop: 8, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}>{f.v}</p>
          </div>
        ))}
      </div>
    </section>
  </div>
);

const ModeTile = ({ icon, title, line, accent }) => (
  <div style={{
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12,
    padding: 18, display: "flex", gap: 14, alignItems: "center",
    boxShadow: "var(--shadow-1)",
  }}>
    <div style={{ width: 44, height: 44, borderRadius: 8, background: `${accent}22`, color: accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Icon name={icon} size={22}/>
    </div>
    <div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600, lineHeight: 1.1 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{line}</div>
    </div>
  </div>
);

window.LandingScreen = LandingScreen;
