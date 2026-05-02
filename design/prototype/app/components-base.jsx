// Extra primitives layered on top of ui.jsx
const TopBar = ({ active, onNav, onLanding, mode = "Solo" }) => (
  <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 32px", borderBottom: "1px solid var(--border)", background: "var(--bg-elev)", flexShrink: 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={onLanding}>
      <Icon name="logo-d20" size={22}/>
      <Wordmark size={18}/>
    </div>
    <nav style={{ marginLeft: 24, display: "flex", gap: 4 }}>
      {["Campaigns", "Characters", "SRD"].map(n => (
        <button key={n} onClick={() => onNav && onNav(n.toLowerCase())} style={{
          background: active === n.toLowerCase() ? "var(--bg-card)" : "transparent",
          color: active === n.toLowerCase() ? "var(--fg)" : "var(--fg-muted)",
          border: "none", height: 28, padding: "0 12px", borderRadius: 6,
          fontFamily: "var(--font-ui)", fontSize: 13, fontWeight: 500, cursor: "pointer",
        }}>{n}</button>
      ))}
    </nav>
    <div style={{ flex: 1 }}/>
    <Chip tone="accent" dot>{mode}</Chip>
    <Button variant="ghost" size="sm" icon="settings"/>
    <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--bone)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink)" }}><Icon name="user" size={14}/></div>
  </header>
);

// Card primitive
const Card = ({ onClick, children, style, accent }) => (
  <div onClick={onClick} style={{
    background: "var(--bg-card)", border: `1px solid ${accent ? "var(--arcane)" : "var(--border)"}`,
    borderRadius: 8, padding: 18, boxShadow: "var(--shadow-1)",
    cursor: onClick ? "pointer" : "default",
    display: "flex", flexDirection: "column", gap: 10,
    transition: "border-color 120ms ease-out, transform 80ms ease-out",
    ...style,
  }} onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = "var(--border-strong)"; }}
     onMouseLeave={e => { if (onClick) e.currentTarget.style.borderColor = accent ? "var(--arcane)" : "var(--border)"; }}>
    {children}
  </div>
);

// Steps progress (used by wizard / campaign creation)
const StepBar = ({ steps, current }) => (
  <div style={{ display: "flex", gap: 4, padding: "16px 32px", borderBottom: "1px solid var(--border)", background: "var(--bg-elev)", overflow: "auto", flexShrink: 0 }}>
    {steps.map((s, i) => (
      <div key={s} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999,
        fontSize: 12, fontWeight: 500,
        color: i === current ? "var(--ink)" : i < current ? "var(--fg)" : "var(--fg-muted)",
        background: i === current ? "var(--bone)" : i < current ? "var(--bg-card)" : "transparent",
        border: i < current ? "1px solid var(--border)" : "1px solid transparent",
        whiteSpace: "nowrap",
      }}>
        <span style={{
          width: 18, height: 18, borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600,
          background: i === current ? "var(--ink)" : "transparent",
          color: i === current ? "var(--bone)" : "currentColor",
          border: i !== current ? "1px solid currentColor" : "none",
          opacity: i === current ? 1 : 0.6,
        }}>{i < current ? "✓" : i + 1}</span>
        {s}
      </div>
    ))}
  </div>
);

const HpBar = ({ cur, max }) => {
  const pct = Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
  const tone = pct <= 25 ? "var(--ember)" : pct <= 50 ? "var(--gold)" : "var(--verdigris)";
  return (
    <div style={{ height: 6, borderRadius: 3, background: "var(--bg-sunken)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: tone, transition: "width 220ms" }}/>
    </div>
  );
};

// A subtle d20 silhouette big art for empty/hero
const ParchmentVignette = ({ style, size = 220 }) => (
  <svg width={size} height={size} viewBox="0 0 200 200" style={{ opacity: 0.10, ...style }}>
    <defs>
      <radialGradient id="parch-v" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.4"/>
        <stop offset="100%" stopColor="var(--gold)" stopOpacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="100" cy="100" r="100" fill="url(#parch-v)"/>
    <polygon points="100,20 170,55 170,145 100,180 30,145 30,55" fill="none" stroke="currentColor" strokeWidth="1"/>
    <polygon points="100,20 170,55 100,90 30,55" fill="none" stroke="currentColor" strokeWidth="1"/>
    <line x1="100" y1="90" x2="100" y2="180" stroke="currentColor" strokeWidth="1"/>
    <line x1="100" y1="90" x2="170" y2="145" stroke="currentColor" strokeWidth="1"/>
    <line x1="100" y1="90" x2="30" y2="145" stroke="currentColor" strokeWidth="1"/>
  </svg>
);

Object.assign(window, { TopBar, Card, StepBar, HpBar, ParchmentVignette });
