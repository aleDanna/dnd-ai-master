// Hub — unified Campaigns + Characters view
const HubScreen = ({ onOpenCampaign, onNewCampaign, onNewCharacter, onOpenCharacter, onLanding, onNav }) => {
  const [tab, setTab] = React.useState("campaigns");
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <TopBar active={tab} onNav={setTab} onLanding={onLanding}/>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "40px 32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 28 }}>
          <div>
            <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Your table</h1>
            <p style={{ marginTop: 8, color: "var(--fg-muted)", fontSize: 15, fontFamily: "var(--font-display)", fontStyle: "italic" }}>Three campaigns in flight, two heroes between rests.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="md" icon="user" onClick={onNewCharacter}>New character</Button>
            <Button variant="primary" size="md" icon="plus" onClick={onNewCampaign}>New campaign</Button>
          </div>
        </div>

        {/* Section: Campaigns */}
        <SectionHeader eyebrow="Campaigns" title="Active and recent" count={4}/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16, marginBottom: 48 }}>
          {campaigns.map(c => (
            <CampaignCard key={c.id} c={c} onClick={() => onOpenCampaign(c.id)}/>
          ))}
          <button onClick={onNewCampaign} style={{
            background: "transparent", border: "1px dashed var(--border-strong)", borderRadius: 8,
            padding: 18, minHeight: 200, color: "var(--fg-muted)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
            cursor: "pointer", fontFamily: "inherit",
          }}>
            <Icon name="plus" size={24}/>
            <span style={{ fontSize: 14 }}>Start a new campaign</span>
          </button>
        </div>

        <SectionHeader eyebrow="Heroes" title="Your characters" count={2}/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {characters.map(ch => <CharacterCard key={ch.id} ch={ch} onClick={() => onOpenCharacter(ch.id)}/>)}
          <button onClick={onNewCharacter} style={{
            background: "transparent", border: "1px dashed var(--border-strong)", borderRadius: 8,
            padding: 18, minHeight: 140, color: "var(--fg-muted)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
            cursor: "pointer", fontFamily: "inherit",
          }}>
            <Icon name="plus" size={20}/>
            <span style={{ fontSize: 13 }}>Roll a new character</span>
          </button>
        </div>
      </div>
    </div>
  );
};

const SectionHeader = ({ eyebrow, title, count }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
    <Eyebrow>{eyebrow}</Eyebrow>
    <h2 style={{ fontSize: 24, fontWeight: 600 }}>{title}</h2>
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-subtle)" }}>{count}</span>
  </div>
);

const CampaignCard = ({ c, onClick }) => {
  const modeTone = { solo: "accent", "local-mp": "warn", "remote-mp": "gold" }[c.mode];
  const styleTone = { module: "ok", improv: "accent", hybrid: "gold" }[c.style];
  return (
    <Card onClick={onClick} accent={c.status === "active"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, lineHeight: 1.15 }}>{c.title}</div>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Chip tone={modeTone} dot={c.status === "active"}>{c.modeLabel}</Chip>
            <Chip tone={styleTone}>{c.styleLabel}</Chip>
          </div>
        </div>
        <Icon name="more" size={16} style={{ color: "var(--fg-subtle)" }}/>
      </div>

      <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 15, color: "var(--fg-muted)", lineHeight: 1.5 }}>“{c.scene}”</div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {c.party.map(p => (
          <span key={p.name} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px 3px 4px",
            borderRadius: 999, background: "var(--bg-sunken)", border: "1px solid var(--border)",
            fontSize: 11,
          }}>
            <span style={{ width: 18, height: 18, borderRadius: "50%", background: p.color, color: "var(--ink)", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>{p.name[0]}</span>
            {p.name}
            {!p.online && c.mode === "remote-mp" && <span style={{ color: "var(--fg-subtle)" }}>·</span>}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        <span>session {c.session}/{c.sessionsTotal}</span>
        <span>·</span>
        <span>{c.turns} turns</span>
        <span>·</span>
        <span>{c.updated}</span>
      </div>
    </Card>
  );
};

const CharacterCard = ({ ch, onClick }) => (
  <Card onClick={onClick}>
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <div style={{ width: 48, height: 48, borderRadius: 8, background: ch.color, color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{ch.name[0]}</div>
      <div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600, lineHeight: 1.1 }}>{ch.name}</div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{ch.race} · {ch.cls} {ch.level}</div>
      </div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
      <MiniStat label="HP" value={`${ch.hp}/${ch.hpMax}`}/>
      <MiniStat label="AC" value={ch.ac}/>
      <MiniStat label="LVL" value={ch.level}/>
    </div>
    <div style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{ch.campaign}</div>
  </Card>
);

const MiniStat = ({ label, value }) => (
  <div style={{ background: "var(--bg-sunken)", borderRadius: 6, padding: "6px 0", textAlign: "center" }}>
    <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-subtle)" }}>{label}</div>
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, marginTop: 1 }}>{value}</div>
  </div>
);

const campaigns = [
  { id: "hollowcreek", title: "The Mill at Hollowcreek", mode: "solo", modeLabel: "Solo", style: "improv", styleLabel: "Improvised", status: "active",
    scene: "Goblin warren beneath the mill — combat, round 3.",
    party: [{ name: "Tharion", color: "#E0B84A" }],
    session: 1, sessionsTotal: 1, turns: 24, updated: "2 min ago" },
  { id: "lanterns", title: "Le Lanterne di Velmora", mode: "local-mp", modeLabel: "Local · 3 players", style: "hybrid", styleLabel: "Hybrid", status: "active",
    scene: "I lampioni si spengono uno a uno lungo la via.",
    party: [{ name: "Bria", color: "#9C73D6" }, { name: "Korvan", color: "#F0533A" }, { name: "Aelis", color: "#2D8F6F" }],
    session: 4, sessionsTotal: 6, turns: 187, updated: "yesterday" },
  { id: "ironroot", title: "The Ironroot Vault", mode: "remote-mp", modeLabel: "Remote · 4 players", style: "module", styleLabel: "Module: Lost Mines", status: "active",
    scene: "Doors of black iron, rune-warmed. The wizard's voice from the other side.",
    party: [{ name: "Dorn", color: "#B5A48A", online: true }, { name: "Sera", color: "#D7331C", online: true }, { name: "Quill", color: "#7A4FB8", online: false }, { name: "Mira", color: "#E0B84A", online: true }],
    session: 7, sessionsTotal: 12, turns: 412, updated: "3 days ago" },
  { id: "ember-coast", title: "Embers of the Coast", mode: "solo", modeLabel: "Solo", style: "module", styleLabel: "Module: Saltmarsh", status: "ended",
    scene: "Epilogue. The lighthouse stands. The Coastguard remembers your name.",
    party: [{ name: "Vex", color: "#E68A2C" }],
    session: 6, sessionsTotal: 6, turns: 298, updated: "2 weeks ago" },
];

const characters = [
  { id: "tharion", name: "Tharion", race: "Half-Elf", cls: "Fighter", level: 3, hp: 21, hpMax: 27, ac: 16, color: "#E0B84A", campaign: "Hollowcreek · active" },
  { id: "bria", name: "Bria", race: "Tiefling", cls: "Sorcerer", level: 2, hp: 14, hpMax: 14, ac: 12, color: "#9C73D6", campaign: "Velmora · active" },
];

window.HubScreen = HubScreen;
