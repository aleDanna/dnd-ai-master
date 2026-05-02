// Shared UI primitives for the D&D AI Master kit
// (browser-loaded via Babel; everything attached to window for cross-script use)

const Icon = ({ name, size = 16, color, style, ...rest }) => {
  const props = {
    width: size, height: size,
    viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor",
    strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
    style: { color, ...style }, ...rest,
  };
  switch (name) {
    case "dice":
      return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="16" cy="16" r="1.2" fill="currentColor"/><circle cx="16" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="16" r="1.2" fill="currentColor"/></svg>;
    case "heart":
      return <svg {...props}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/></svg>;
    case "shield":
      return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "sword":
      return <svg {...props}><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/></svg>;
    case "spell":
      return <svg {...props}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>;
    case "book":
      return <svg {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>;
    case "chat":
      return <svg {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
    case "send":
      return <svg {...props}><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>;
    case "plus":
      return <svg {...props}><path d="M12 5v14M5 12h14"/></svg>;
    case "arrow-right":
      return <svg {...props}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
    case "arrow-left":
      return <svg {...props}><path d="M19 12H5M12 5l-7 7 7 7"/></svg>;
    case "settings":
      return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
    case "sparkle":
      return <svg {...props}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>;
    case "check":
      return <svg {...props}><path d="M20 6 9 17l-5-5"/></svg>;
    case "x":
      return <svg {...props}><path d="M18 6 6 18M6 6l12 12"/></svg>;
    case "user":
      return <svg {...props}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
    case "more":
      return <svg {...props}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>;
    case "logo-d20":
      return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" style={{color, ...style}}><polygon points="16,2 29,9 29,23 16,30 3,23 3,9"/><polygon points="16,2 29,9 16,16 3,9"/><line x1="16" y1="16" x2="16" y2="30"/><line x1="16" y1="16" x2="29" y2="23"/><line x1="16" y1="16" x2="3" y2="23"/></svg>;
    default:
      return null;
  }
};

const Wordmark = ({ size = 28, style }) => (
  <span style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontWeight: 600, fontSize: size, letterSpacing: "-0.01em", lineHeight: 1, ...style }}>
    AI<span style={{ fontStyle: "italic", fontWeight: 500 }}>&amp;</span>Games
  </span>
);

const Button = ({ variant = "primary", size = "md", icon, iconRight, children, disabled, onClick, style, ...rest }) => {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    fontFamily: "var(--font-ui)", fontWeight: 500,
    border: "1px solid transparent", borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "background-color 120ms ease-out, border-color 120ms ease-out, transform 80ms ease-out",
    whiteSpace: "nowrap",
  };
  const sizes = {
    sm: { height: 28, padding: "0 10px", fontSize: 13 },
    md: { height: 36, padding: "0 14px", fontSize: 14 },
    lg: { height: 44, padding: "0 18px", fontSize: 15 },
  };
  const variants = {
    primary:   { background: "var(--arcane)", color: "#fff" },
    secondary: { background: "var(--bg-card)", color: "var(--fg)", borderColor: "var(--border-strong)" },
    ghost:     { background: "transparent", color: "var(--fg)" },
    danger:    { background: "var(--ember)", color: "#fff" },
    accent:    { background: "var(--gold)", color: "var(--ink)" },
  };
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseDown={e => !disabled && (e.currentTarget.style.transform = "scale(0.98)")}
      onMouseUp={e => (e.currentTarget.style.transform = "")}
      onMouseLeave={e => (e.currentTarget.style.transform = "")}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16}/> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={size === "sm" ? 14 : 16}/> : null}
    </button>
  );
};

const Chip = ({ tone = "neutral", children, dot }) => {
  const tones = {
    neutral: { bg: "var(--bone)", fg: "var(--ink)", bd: "var(--border)" },
    accent:  { bg: "rgba(122,79,184,0.14)", fg: "var(--arcane)", bd: "rgba(122,79,184,0.30)" },
    warn:    { bg: "rgba(184,84,50,0.12)", fg: "var(--ember)", bd: "rgba(184,84,50,0.25)" },
    ok:      { bg: "rgba(92,138,107,0.14)", fg: "var(--verdigris)", bd: "rgba(92,138,107,0.28)" },
    gold:    { bg: "rgba(197,163,87,0.18)", fg: "#7A5F22", bd: "rgba(197,163,87,0.4)" },
  }[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, background: tones.bg, color: tones.fg, border: `1px solid ${tones.bd}`, lineHeight: 1 }}>
      {dot ? <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }}/> : null}
      {children}
    </span>
  );
};

const Eyebrow = ({ children, style }) => (
  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)", ...style }}>{children}</div>
);

const Field = ({ label, children, style }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
    <Eyebrow>{label}</Eyebrow>
    {children}
  </label>
);

const Input = ({ style, ...rest }) => (
  <input style={{ background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "9px 12px", fontFamily: "var(--font-ui)", fontSize: 14, outline: "none", ...style }} {...rest}/>
);

const TextArea = ({ style, ...rest }) => (
  <textarea style={{ background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "10px 12px", fontFamily: "var(--font-ui)", fontSize: 14, outline: "none", resize: "vertical", ...style }} {...rest}/>
);

Object.assign(window, { Icon, Wordmark, Button, Chip, Eyebrow, Field, Input, TextArea });
