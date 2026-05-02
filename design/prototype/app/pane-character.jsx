// CharacterPane — left pane
const CharacterPane = ({ character, state }) => {
  const hpPct = Math.round((state.hp / character.hpMax) * 100);
  const hpTone = hpPct <= 25 ? "var(--ember)" : hpPct <= 50 ? "var(--gold)" : "var(--verdigris)";
  return (
    <aside style={{ width: 280, padding: 18, borderRight: "1px solid var(--border)", background: "var(--bg-elev)", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", flexShrink: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ width: 52, height: 52, borderRadius: 8, background: "var(--bone)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 24, fontStyle: "italic", fontWeight: 600 }}>{character.name[0]}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>{character.name}</div>
          <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{character.race} · {character.cls} {character.level}</div>
        </div>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Eyebrow>Hit Points</Eyebrow>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 600 }}>{state.hp} / {character.hpMax}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--bg-sunken)", marginTop: 6, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${hpPct}%`, background: hpTone, transition: "width 220ms" }}/>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        <StatTile label="AC" value={character.ac}/>
        <StatTile label="Speed" value={`${character.speed}'`}/>
        <StatTile label="PB" value={`+${character.pb}`}/>
      </div>

      <div>
        <Eyebrow style={{ marginBottom: 6 }}>Abilities</Eyebrow>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 4 }}>
          {Object.entries(character.abilities).map(([k, v]) => {
            const mod = Math.floor((v - 10) / 2);
            return (
              <div key={k} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 0", textAlign: "center" }}>
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)" }}>{k}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 600 }}>{v}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>{mod >= 0 ? "+" : ""}{mod}</div>
              </div>
            );
          })}
        </div>
      </div>

      {state.conditions.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Conditions</Eyebrow>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{state.conditions.map(c => <Chip key={c} tone="warn" dot>{c}</Chip>)}</div>
        </div>
      )}

      {character.cls === "Sorcerer" || character.cls === "Cleric" ? (
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Spell slots</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[{ lv: 1, max: 3, used: 1 }].map(s => (
              <div key={s.lv} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ width: 28, fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>Lv {s.lv}</span>
                <div style={{ display: "flex", gap: 4, flex: 1 }}>
                  {Array.from({ length: s.max }).map((_, i) => (
                    <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid var(--arcane)", background: i < s.used ? "transparent" : "var(--arcane)" }}/>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <Eyebrow style={{ marginBottom: 6 }}>Resources</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {character.resources.map(r => (
            <div key={r.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span>{r.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>{r.cur} / {r.max}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <Eyebrow style={{ marginBottom: 6 }}>Inventory</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {character.inventory.map(i => (
            <div key={i.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: i.equipped ? "var(--fg)" : "var(--fg-muted)" }}>{i.equipped ? "▸ " : "  "}{i.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-subtle)" }}>{i.qty > 1 ? `×${i.qty}` : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
};

const StatTile = ({ label, value }) => (
  <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 0", textAlign: "center" }}>
    <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)" }}>{label}</div>
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
  </div>
);

window.CharacterPane = CharacterPane;
