// NarrativePane — center pane: chat + composer, with quick-action bar
const NarrativePane = ({ messages, onSend, busy, mode, gameMode, onSpell }) => {
  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef(null);
  React.useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages.length, busy]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    onSend(draft.trim());
    setDraft("");
  };

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "32px 40px 16px" }}>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22 }}>
          {messages.map((m, i) => <Message key={i} m={m}/>)}
          {busy && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--fg-muted)", fontFamily: "var(--font-display)", fontSize: 16, fontStyle: "italic" }}>
              <SpinningDie/> The Master is responding…
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: "10px 40px 0", borderTop: "1px solid var(--border)", background: "var(--bg-elev)" }}>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", gap: 6, paddingTop: 8, paddingBottom: 4, flexWrap: "wrap" }}>
          <QuickAction icon="dice" label="Skill check"/>
          <QuickAction icon="sword" label={gameMode === "combat" ? "Attack" : "Roll d20"}/>
          <QuickAction icon="spell" label="Cast spell" onClick={onSpell}/>
          <QuickAction icon="shield" label="Dodge"/>
          <QuickAction icon="heart" label="Short rest"/>
          <div style={{ flex: 1 }}/>
          <QuickAction icon="book" label="Look up rule"/>
        </div>
      </div>

      <div style={{ padding: "8px 40px 20px", background: "var(--bg-elev)" }}>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", gap: 8, alignItems: "flex-end", background: "var(--bg-card)", border: "1px solid var(--border-strong)", borderRadius: 12, padding: 8 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={mode === "local-mp" ? "Bria, what do you do?" : "What do you do?"}
            rows={2}
            style={{ flex: 1, border: "none", outline: "none", resize: "none", background: "transparent", color: "var(--fg)", fontFamily: "var(--font-ui)", fontSize: 14, lineHeight: 1.5, padding: "6px 8px" }}
          />
          <Button variant="primary" size="md" icon="send" disabled={busy || !draft.trim()} onClick={submit}>Send</Button>
        </div>
        <div style={{ maxWidth: 680, margin: "6px auto 0", fontSize: 11, color: "var(--fg-subtle)", textAlign: "center" }}>
          Enter to send · Shift+Enter for new line · Type in any language — the Master mirrors yours
        </div>
      </div>
    </main>
  );
};

const QuickAction = ({ icon, label, onClick }) => (
  <button onClick={onClick} style={{
    display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px",
    background: "transparent", border: "1px solid var(--border)", borderRadius: 999,
    color: "var(--fg-muted)", fontFamily: "var(--font-ui)", fontSize: 12, cursor: "pointer",
  }}>
    <Icon name={icon} size={13}/> {label}
  </button>
);

const Message = ({ m }) => {
  if (m.role === "master") {
    return (
      <div>
        <Eyebrow style={{ marginBottom: 6 }}>The Master</Eyebrow>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 18, lineHeight: 1.55, color: "var(--fg)" }} dangerouslySetInnerHTML={{ __html: m.content }}/>
        {m.tools && m.tools.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {m.tools.map((t, i) => <ToolPill key={i} {...t}/>)}
          </div>
        )}
      </div>
    );
  }
  if (m.role === "player") {
    return (
      <div style={{ alignSelf: "flex-end", marginLeft: "auto", maxWidth: "85%" }}>
        {m.who && m.who !== "you" && <div style={{ fontSize: 10, color: "var(--fg-subtle)", textAlign: "right", marginBottom: 4, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 0.5 }}>{m.who}</div>}
        <div style={{ background: "var(--bone)", color: "var(--ink)", borderRadius: "12px 12px 4px 12px", padding: "10px 14px", fontSize: 14, lineHeight: 1.5 }}>{m.content}</div>
      </div>
    );
  }
  if (m.role === "system") {
    return (
      <div style={{ alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, background: "var(--bg-card)", border: "1px dashed var(--border-strong)", fontSize: 12, color: "var(--fg-muted)", fontFamily: "var(--font-mono)" }}>
        <Icon name="settings" size={12}/> {m.content}
      </div>
    );
  }
  return null;
};

const ToolPill = ({ tool, formula, result, status }) => {
  const tone = status === "ok" ? "var(--verdigris)" : status === "err" ? "var(--ember)" : "var(--fg-muted)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "var(--bg-card)", border: "1px solid var(--border)", padding: "4px 10px", borderRadius: 999, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
      <span style={{ color: "var(--fg)" }}>⚙ {tool}</span>
      {formula && <span>{formula}</span>}
      {result && <span style={{ color: tone, fontWeight: 600 }}>→ {result}</span>}
    </span>
  );
};

const SpinningDie = () => (<span style={{ display: "inline-block", animation: "spin 1.2s linear infinite" }}><Icon name="logo-d20" size={16}/></span>);

// SpellModal — spell-slot picker
const SpellModal = ({ onClose }) => (
  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", zIndex: 10 }} onClick={onClose}>
    <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-card)", border: "1px solid var(--border-strong)", borderRadius: 12, padding: 24, width: 480, boxShadow: "var(--shadow-3)" }}>
      <Eyebrow>Cast a spell</Eyebrow>
      <h3 style={{ fontSize: 22, fontFamily: "var(--font-display)", fontWeight: 600, marginTop: 4 }}>Magic Missile</h3>
      <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.55 }}>You create three glowing darts of magical force. Each dart hits a creature of your choice, dealing <strong style={{ color: "var(--fg)" }}>1d4+1 force</strong> damage. The darts strike simultaneously, and you can direct them at the same target or several.</p>
      <div style={{ marginTop: 16 }}>
        <Eyebrow>Choose a slot</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {[
            { lv: 1, used: 1, max: 3, eff: "3 darts · 1d4+1 each" },
            { lv: 2, used: 0, max: 0, eff: "—", disabled: true },
          ].map(s => (
            <button key={s.lv} disabled={s.disabled} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
              background: s.disabled ? "var(--bg-sunken)" : "var(--bg-elev)",
              border: "1px solid " + (s.lv === 1 ? "var(--arcane)" : "var(--border)"),
              borderRadius: 8, cursor: s.disabled ? "not-allowed" : "pointer",
              opacity: s.disabled ? 0.4 : 1, color: "inherit", fontFamily: "inherit",
            }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600 }}>Lv {s.lv}</span>
              <div style={{ display: "flex", gap: 4, flex: 1 }}>
                {Array.from({ length: Math.max(s.max, 1) }).map((_, i) => (
                  <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid var(--arcane)", background: i < s.used ? "transparent" : "var(--arcane)" }}/>
                ))}
              </div>
              <span style={{ fontSize: 12, color: "var(--fg-muted)", fontFamily: "var(--font-mono)" }}>{s.eff}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
        <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="md" icon="spell" onClick={onClose}>Cast at level 1</Button>
      </div>
    </div>
  </div>
);

window.NarrativePane = NarrativePane;
