// MultiplayerLobby — for both local pass-and-play and remote rooms
const MultiplayerLobby = ({ campaignId, mode = "remote-mp", onStart, onBack }) => {
  const [seats, setSeats] = React.useState(initialSeats(mode));
  const isLocal = mode === "local-mp";
  const allReady = seats.every(s => s.status === "ready");

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 32px", borderBottom: "1px solid var(--border)" }}>
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>Campaign</Button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 18 }}>Le Lanterne di Velmora</div>
          <div style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{isLocal ? "LOCAL · pass and play" : "REMOTE · room aigames.app/r/velmora-7Q3-fjk"}</div>
        </div>
        <Chip tone={isLocal ? "warn" : "gold"} dot>{isLocal ? "At the table" : `${seats.filter(s => s.status !== "empty").length}/${seats.length} joined`}</Chip>
      </header>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px" }}>
          {!isLocal && (
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 24, display: "flex", gap: 12, alignItems: "center" }}>
              <Icon name="send" size={18} style={{ color: "var(--arcane)" }}/>
              <div style={{ flex: 1 }}>
                <Eyebrow>Invite link</Eyebrow>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>aigames.app/r/velmora-7Q3-fjk</code>
              </div>
              <Button variant="secondary" size="sm">Copy link</Button>
              <Button variant="ghost" size="sm" icon="settings">Permissions</Button>
            </div>
          )}

          <Eyebrow style={{ marginBottom: 12 }}>{isLocal ? "Players at the table" : "Seats"}</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {seats.map((s, i) => <SeatCard key={i} seat={s} mode={mode} onChange={ns => setSeats(arr => arr.map((x, j) => j === i ? ns : x))}/>)}
            {!isLocal && (
              <button style={{ background: "transparent", border: "1px dashed var(--border-strong)", borderRadius: 8, padding: 18, color: "var(--fg-muted)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 180, fontFamily: "inherit" }}>
                <Icon name="plus" size={20}/><span style={{ fontSize: 13 }}>Add seat</span>
              </button>
            )}
          </div>

          {isLocal && (
            <div style={{ marginTop: 32, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 18 }}>
              <Eyebrow style={{ marginBottom: 8 }}>How pass-and-play works</Eyebrow>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.7 }}>
                <li>The Master narrates aloud — everyone listens together.</li>
                <li>When it's your PC's turn, the screen switches to your sheet automatically. The current actor gets a colored ring around the screen.</li>
                <li>Type or speak your action. Tap <em>End turn</em> when done. The next player takes the device.</li>
                <li>Out-of-turn things (group skill checks, reactions) prompt every player one by one.</li>
              </ol>
            </div>
          )}

          <div style={{ marginTop: 32, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600 }}>The Master is ready</div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>Hybrid campaign · 4 milestones loaded · language auto-detect on first message</div>
            </div>
            <Button variant="accent" size="lg" icon="dice" iconRight="arrow-right" disabled={!allReady && !isLocal} onClick={onStart}>{allReady || isLocal ? "Begin session" : `Waiting on ${seats.filter(s => s.status !== "ready").length}…`}</Button>
          </div>
        </div>
      </div>
    </div>
  );
};

const initialSeats = (mode) => {
  if (mode === "local-mp") {
    return [
      { name: "Bria",   pc: "Tiefling Sorcerer 2",   status: "ready", color: "#9C73D6", host: true },
      { name: "Korvan", pc: "Half-Orc Barbarian 2",  status: "ready", color: "#F0533A" },
      { name: "Aelis",  pc: "Wood Elf Druid 2",      status: "ready", color: "#2D8F6F" },
    ];
  }
  return [
    { name: "Dorn (you)", pc: "Dwarf Cleric 1",  status: "ready",   color: "#B5A48A", host: true },
    { name: "Sera",       pc: "Human Rogue 1",   status: "ready",   color: "#D7331C" },
    { name: "Quill",      pc: "Gnome Wizard 1",  status: "joining", color: "#7A4FB8" },
    { name: "Mira",       pc: null,              status: "empty",   color: "#E0B84A" },
  ];
};

const SeatCard = ({ seat, mode }) => {
  const tone = { ready: "ok", joining: "warn", empty: "neutral" }[seat.status];
  const label = { ready: "ready", joining: "joining…", empty: "empty seat" }[seat.status];
  return (
    <div style={{ background: "var(--bg-card)", border: seat.status === "empty" ? "1px dashed var(--border-strong)" : "1px solid var(--border)", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 12, minHeight: 180 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: seat.status === "empty" ? "var(--bg-sunken)" : seat.color, color: "var(--ink)", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {seat.status === "empty" ? <Icon name="user" size={16} style={{ color: "var(--fg-subtle)" }}/> : seat.name[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            {seat.status === "empty" ? <span style={{ color: "var(--fg-muted)" }}>Empty</span> : seat.name}
            {seat.host && <Chip tone="accent">host</Chip>}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{seat.pc || "—"}</div>
        </div>
      </div>
      <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Chip tone={tone} dot={seat.status === "ready"}>{label}</Chip>
        {seat.status === "empty" && mode === "remote-mp" && <Button variant="ghost" size="sm" icon="send">Invite</Button>}
        {seat.status === "empty" && mode === "local-mp" && <Button variant="ghost" size="sm" icon="plus">Pick PC</Button>}
        {seat.status === "joining" && <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>building character…</span>}
      </div>
    </div>
  );
};

window.MultiplayerLobby = MultiplayerLobby;
