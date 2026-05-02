// CampaignWizard — 4 steps: Mode, Style, Party, Premise
const CampaignWizard = ({ onCancel, onCreate }) => {
  const steps = ["Mode", "Style", "Party", "Premise"];
  const [step, setStep] = React.useState(0);
  const [mode, setMode] = React.useState("solo");
  const [style, setStyle] = React.useState("improv");
  const [module_, setModule] = React.useState("lost-mines");
  const [tone, setTone] = React.useState("classic-fantasy");
  const [premise, setPremise] = React.useState("A coastal village wakes to find every door marked with the same sigil. The town watch has vanished. The fog has not lifted in three days.");
  const [party, setParty] = React.useState([
    { id: 1, name: "Tharion", role: "host", char: "tharion" },
  ]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 32px", borderBottom: "1px solid var(--border)" }}>
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onCancel}>Cancel</Button>
        <div style={{ flex: 1, textAlign: "center", fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 18 }}>New campaign</div>
        <div style={{ width: 100 }}/>
      </header>
      <StepBar steps={steps} current={step}/>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "40px 32px 120px" }}>
          {step === 0 && <ModeStep mode={mode} setMode={setMode}/>}
          {step === 1 && <StyleStep style={style} setStyle={setStyle} module_={module_} setModule={setModule} tone={tone} setTone={setTone}/>}
          {step === 2 && <PartyStep mode={mode} party={party} setParty={setParty}/>}
          {step === 3 && <PremiseStep style={style} premise={premise} setPremise={setPremise} mode={mode} party={party}/>}
        </div>
      </div>

      <footer style={{ display: "flex", justifyContent: "space-between", padding: "16px 32px", borderTop: "1px solid var(--border)", background: "var(--bg-elev)" }}>
        <Button variant="ghost" size="md" disabled={step === 0} onClick={() => setStep(s => s - 1)} icon="arrow-left">Back</Button>
        <div style={{ fontSize: 12, color: "var(--fg-subtle)", alignSelf: "center" }}>Step {step + 1} of {steps.length}</div>
        {step < steps.length - 1 ? (
          <Button variant="primary" size="md" iconRight="arrow-right" onClick={() => setStep(s => s + 1)}>Next: {steps[step + 1]}</Button>
        ) : (
          <Button variant="primary" size="md" icon="sparkle" onClick={() => onCreate({ mode, style, premise, party })}>Begin the tale</Button>
        )}
      </footer>
    </div>
  );
};

const BigChoice = ({ icon, title, desc, selected, onClick, accent = "var(--arcane)" }) => (
  <button onClick={onClick} style={{
    textAlign: "left", padding: 20, borderRadius: 10,
    background: "var(--bg-card)",
    border: selected ? `2px solid ${accent}` : "1px solid var(--border)",
    cursor: "pointer", fontFamily: "inherit", color: "inherit",
    display: "flex", flexDirection: "column", gap: 12,
    boxShadow: selected ? "var(--shadow-2)" : "var(--shadow-1)",
    position: "relative",
  }}>
    <div style={{ width: 44, height: 44, borderRadius: 10, background: selected ? `${accent}22` : "var(--bg-sunken)", color: selected ? accent : "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={22}/>
    </div>
    <div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}>{desc}</div>
    </div>
    {selected && <div style={{ position: "absolute", top: 14, right: 14, color: accent }}><Icon name="check" size={18}/></div>}
  </button>
);

const ModeStep = ({ mode, setMode }) => (
  <div>
    <h2 style={{ fontSize: 32, fontWeight: 600, marginBottom: 8 }}>How will you play?</h2>
    <p style={{ color: "var(--fg-muted)", fontSize: 15, marginBottom: 28, fontFamily: "var(--font-display)", fontStyle: "italic" }}>This is fixed for the life of the campaign — the engine handles each mode differently.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
      <BigChoice icon="user" title="Solo" desc="Just you and the Master. Best for a focused one-shot or a multi-session story you fit into your schedule." selected={mode === "solo"} onClick={() => setMode("solo")} accent="var(--arcane)"/>
      <BigChoice icon="chat" title="Local pass-and-play" desc="One device at the kitchen table. Players take turns; the screen switches to whoever's PC is acting. The Master narrates aloud to the room." selected={mode === "local-mp"} onClick={() => setMode("local-mp")} accent="var(--ember)"/>
      <BigChoice icon="sparkle" title="Remote room" desc="Friends in different cities. Each player joins from their own device. Real-time turns, presence, shared dice log." selected={mode === "remote-mp"} onClick={() => setMode("remote-mp")} accent="var(--gold)"/>
    </div>
  </div>
);

const StyleStep = ({ style, setStyle, module_, setModule, tone, setTone }) => (
  <div>
    <h2 style={{ fontSize: 32, fontWeight: 600, marginBottom: 8 }}>Who writes the story?</h2>
    <p style={{ color: "var(--fg-muted)", fontSize: 15, marginBottom: 28, fontFamily: "var(--font-display)", fontStyle: "italic" }}>The Master can run a published adventure, improvise from a seed, or strike a middle path.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 32 }}>
      <BigChoice icon="book" title="Pre-written module" desc="A published adventure with locations, NPCs and encounters. The Master runs it like a human DM — faithful to the text, responsive to your choices." selected={style === "module"} onClick={() => setStyle("module")} accent="var(--verdigris)"/>
      <BigChoice icon="sparkle" title="Fully improvised" desc="From a one-line seed, the Master invents the world as you play. No predetermined plot. Everything emergent." selected={style === "improv"} onClick={() => setStyle("improv")} accent="var(--arcane)"/>
      <BigChoice icon="dice" title="Hybrid" desc="The Master generates a skeleton with fixed milestones, improvises in between. Structure and freedom both." selected={style === "hybrid"} onClick={() => setStyle("hybrid")} accent="var(--gold)"/>
    </div>

    {style === "module" && (
      <div>
        <Eyebrow style={{ marginBottom: 10 }}>Choose a module</Eyebrow>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
          {modules.map(m => (
            <button key={m.id} onClick={() => setModule(m.id)} style={{
              textAlign: "left", padding: 14, borderRadius: 8,
              background: "var(--bg-card)",
              border: module_ === m.id ? "2px solid var(--verdigris)" : "1px solid var(--border)",
              cursor: "pointer", fontFamily: "inherit", color: "inherit",
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 600 }}>{m.title}</div>
                <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>Lv {m.levels}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.45 }}>{m.blurb}</div>
            </button>
          ))}
        </div>
      </div>
    )}

    {(style === "improv" || style === "hybrid") && (
      <div>
        <Eyebrow style={{ marginBottom: 10 }}>Tone</Eyebrow>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tones.map(t => (
            <button key={t.id} onClick={() => setTone(t.id)} style={{
              padding: "8px 14px", borderRadius: 999,
              background: tone === t.id ? "var(--bone)" : "var(--bg-card)",
              color: tone === t.id ? "var(--ink)" : "var(--fg)",
              border: tone === t.id ? "1px solid var(--bone)" : "1px solid var(--border)",
              cursor: "pointer", fontFamily: "inherit", fontSize: 13,
            }}>{t.label}</button>
          ))}
        </div>
      </div>
    )}
  </div>
);

const PartyStep = ({ mode, party, setParty }) => {
  if (mode === "solo") {
    return (
      <div>
        <h2 style={{ fontSize: 32, fontWeight: 600, marginBottom: 8 }}>Pick your hero</h2>
        <p style={{ color: "var(--fg-muted)", fontSize: 15, marginBottom: 28, fontFamily: "var(--font-display)", fontStyle: "italic" }}>Solo campaigns run with a single player character.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          {existingChars.map(ch => (
            <button key={ch.id} style={{
              textAlign: "left", padding: 16, borderRadius: 8,
              background: "var(--bg-card)",
              border: ch.id === "tharion" ? "2px solid var(--arcane)" : "1px solid var(--border)",
              cursor: "pointer", fontFamily: "inherit", color: "inherit",
              display: "flex", gap: 12, alignItems: "center",
            }}>
              <div style={{ width: 44, height: 44, borderRadius: 8, background: ch.color, color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{ch.name[0]}</div>
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600 }}>{ch.name}</div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{ch.race} · {ch.cls} {ch.level}</div>
              </div>
            </button>
          ))}
          <button style={{
            background: "transparent", border: "1px dashed var(--border-strong)", borderRadius: 8,
            padding: 16, color: "var(--fg-muted)",
            display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontFamily: "inherit",
          }}>
            <Icon name="plus" size={18}/>
            <span style={{ fontSize: 13 }}>Roll a new one (wizard)</span>
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2 style={{ fontSize: 32, fontWeight: 600, marginBottom: 8 }}>{mode === "local-mp" ? "Players at the table" : "Invite players"}</h2>
      <p style={{ color: "var(--fg-muted)", fontSize: 15, marginBottom: 28, fontFamily: "var(--font-display)", fontStyle: "italic" }}>
        {mode === "local-mp" ? "Add a slot for each person sitting around the table. They can pick or roll a character now or at the lobby." : "Send invite links. Players pick or build their PC when they join."}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {party.map((p, i) => (
          <div key={p.id} style={{
            display: "flex", alignItems: "center", gap: 12,
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12,
          }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--bone)", color: "var(--ink)", fontFamily: "var(--font-display)", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{p.name[0]}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>{p.name} {p.role === "host" && <Chip tone="accent">host</Chip>}</div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{p.char ? `→ ${p.char}` : "no character yet"}</div>
            </div>
            {mode === "remote-mp" && <Button variant="ghost" size="sm" icon="send">Copy invite</Button>}
            {p.role !== "host" && <Button variant="ghost" size="sm" icon="x" onClick={() => setParty(pt => pt.filter(x => x.id !== p.id))}/>}
          </div>
        ))}
      </div>

      <Button variant="secondary" size="md" icon="plus" onClick={() => setParty(pt => [...pt, { id: Date.now(), name: `Player ${pt.length + 1}`, role: "player", char: null }])}>Add player slot</Button>

      {mode === "remote-mp" && (
        <div style={{ marginTop: 24, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Room link (preview)</Eyebrow>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, background: "var(--bg-sunken)", padding: "8px 12px", borderRadius: 6, color: "var(--fg-muted)" }}>aigames.app/r/velmora-7Q3-fjk</code>
            <Button variant="secondary" size="sm">Copy</Button>
          </div>
        </div>
      )}
    </div>
  );
};

const PremiseStep = ({ style, premise, setPremise, mode, party }) => (
  <div>
    <h2 style={{ fontSize: 32, fontWeight: 600, marginBottom: 8 }}>{style === "module" ? "Review and begin" : "Set the scene"}</h2>
    <p style={{ color: "var(--fg-muted)", fontSize: 15, marginBottom: 28, fontFamily: "var(--font-display)", fontStyle: "italic" }}>
      {style === "module" ? "The Master will narrate the module's opening tailored to your party." : style === "improv" ? "A premise — a place, a hook, a tone. The Master will shape the rest from your first move." : "Sketch the world. The Master will set milestones around your premise."}
    </p>

    {style !== "module" && (
      <div style={{ marginBottom: 24 }}>
        <Field label="Premise">
          <TextArea rows={5} value={premise} onChange={e => setPremise(e.target.value)} style={{ fontFamily: "var(--font-display)", fontSize: 16, lineHeight: 1.55 }}/>
        </Field>
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <Button variant="ghost" size="sm" icon="sparkle">Suggest a premise</Button>
          <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>or write your own — Italian, English, anything in between</span>
        </div>
      </div>
    )}

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <Card style={{ cursor: "default" }}>
        <Eyebrow>Summary</Eyebrow>
        <Row k="Mode" v={modeLabels[mode]}/>
        <Row k="Style" v={style === "module" ? "Lost Mines of Phandelver" : style === "improv" ? "Fully improvised" : "Hybrid milestones"}/>
        <Row k="Party" v={`${party.length} ${party.length === 1 ? "player" : "players"}`}/>
        <Row k="Language" v="Auto · detected from first messages"/>
      </Card>
      <Card style={{ cursor: "default", background: "var(--bg-sunken)" }}>
        <Eyebrow>The Master will</Eyebrow>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.7 }}>
          <li>Mirror your language for the campaign's life</li>
          <li>Roll every die through the engine — no mental math</li>
          <li>Track HP, slots, conditions in your sheets</li>
          <li>Log every tool call for full audit</li>
          {style === "improv" && <li>Improvise NPCs, locations, encounters from your seed</li>}
          {style === "hybrid" && <li>Hold the milestones; improvise the connective tissue</li>}
          {style === "module" && <li>Stay faithful to the module text and pacing</li>}
        </ul>
      </Card>
    </div>
  </div>
);

const Row = ({ k, v }) => (
  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, paddingTop: 4 }}>
    <span style={{ color: "var(--fg-muted)" }}>{k}</span>
    <span style={{ color: "var(--fg)", fontWeight: 500 }}>{v}</span>
  </div>
);

const modeLabels = { solo: "Solo", "local-mp": "Local pass-and-play", "remote-mp": "Remote room" };
const modules = [
  { id: "lost-mines", title: "Lost Mines of Phandelver", levels: "1–5", blurb: "Goblins on the road, a missing dwarf, a hidden mine. The classic intro." },
  { id: "saltmarsh", title: "Ghosts of Saltmarsh", levels: "1–12", blurb: "A coastal town, smugglers, a haunted house. Naval, salt-spray, danger." },
  { id: "icewind", title: "Rime of the Frostmaiden", levels: "1–12", blurb: "Ten towns, eternal night, a winter goddess. Dread and survival." },
  { id: "dragonheist", title: "Dragon Heist", levels: "1–5", blurb: "Waterdeep. Half a million dragons. Four factions. Pick a side." },
];
const tones = [
  { id: "classic-fantasy", label: "Classic fantasy" },
  { id: "dark", label: "Dark / horror" },
  { id: "comedic", label: "Comedic" },
  { id: "investigation", label: "Investigation" },
  { id: "political", label: "Political intrigue" },
  { id: "sword-sandal", label: "Sword & sandal" },
];
const existingChars = [
  { id: "tharion", name: "Tharion", race: "Half-Elf", cls: "Fighter", level: 3, color: "#E0B84A" },
  { id: "bria", name: "Bria", race: "Tiefling", cls: "Sorcerer", level: 2, color: "#9C73D6" },
];

window.CampaignWizard = CampaignWizard;
