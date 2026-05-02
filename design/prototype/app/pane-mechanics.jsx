// MechanicsPane — right pane: combat tracker, dice log, scene
const MechanicsPane = ({ combat, diceLog, scene, gameMode }) => (
  <aside style={{ width: 320, padding: 18, borderLeft: "1px solid var(--border)", background: "var(--bg-elev)", display: "flex", flexDirection: "column", gap: 18, overflowY: "auto", flexShrink: 0 }}>
    {combat ? (
      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Eyebrow>Combat · Round {combat.round}</Eyebrow>
          <Chip tone="warn" dot>Your turn</Chip>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {combat.actors.map((a, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 8px", borderRadius: 6,
              background: a.current ? "rgba(122,79,184,0.14)" : "transparent",
              border: a.current ? "1px solid rgba(122,79,184,0.40)" : "1px solid transparent",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", width: 22, textAlign: "right" }}>{a.init}</span>
              <span style={{ flex: 1, fontSize: 13, color: a.alive ? "var(--fg)" : "var(--fg-subtle)", textDecoration: a.alive ? "none" : "line-through" }}>{a.name}</span>
              {a.alive ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>{a.hp}/{a.hpMax}</span>
                  <div style={{ width: 56, height: 3, background: "var(--bg-sunken)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round((a.hp / a.hpMax) * 100)}%`, background: a.hp / a.hpMax <= 0.25 ? "var(--ember)" : "var(--verdigris)" }}/>
                  </div>
                </div>
              ) : (
                <span style={{ fontSize: 10, color: "var(--ember)", fontFamily: "var(--font-mono)" }}>down</span>
              )}
            </div>
          ))}
        </div>
      </section>
    ) : (
      <section>
        <Eyebrow style={{ marginBottom: 8 }}>{gameMode === "spell" ? "Initiative · pre-round" : "Exploration"}</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--fg-muted)" }}>
          <div style={{ padding: "8px 10px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 13, color: "var(--fg)" }}>No active combat. The Master may call for skill checks.</div>
        </div>
      </section>
    )}

    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Eyebrow>Dice log</Eyebrow>
        <span style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>last 7</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {diceLog.map((d, i) => (
          <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.45, padding: "4px 6px", borderRadius: 4, background: d.crit ? "rgba(224,184,74,0.10)" : "transparent" }}>
            <span style={{ color: "var(--fg-muted)" }}>{d.kind.padEnd(7)}</span>
            <span style={{ color: "var(--fg)" }}> {d.formula} → </span>
            <span style={{ color: d.crit ? "var(--gold)" : d.fail ? "var(--ember)" : "var(--fg)", fontWeight: 600 }}>{d.total}</span>
            {d.note && <div style={{ color: "var(--fg-subtle)", paddingLeft: 56, marginTop: -1 }}>{d.note}</div>}
          </div>
        ))}
      </div>
    </section>

    <section>
      <Eyebrow style={{ marginBottom: 6 }}>Scene</Eyebrow>
      <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 14, lineHeight: 1.55, color: "var(--fg-muted)" }}>{scene}</div>
    </section>
  </aside>
);

window.MechanicsPane = MechanicsPane;
