// CharacterWizard — 7 steps, race step elaborated; others summarized
const CharacterWizard = ({ onCancel, onDone }) => {
  const steps = ["Race", "Class", "Background", "Abilities", "Skills", "Equipment", "Identity"];
  const [step, setStep] = React.useState(0);
  const [race, setRace] = React.useState("half-elf");
  const [cls, setCls] = React.useState("fighter");
  const [bg, setBg] = React.useState("soldier");
  const [aiOpen, setAiOpen] = React.useState(true);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 32px", borderBottom: "1px solid var(--border)" }}>
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onCancel}>Cancel</Button>
        <div style={{ flex: 1, textAlign: "center", fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 18 }}>New character</div>
        <Button variant="ghost" size="sm" icon="sparkle" onClick={() => setAiOpen(o => !o)}>{aiOpen ? "Hide AI" : "Show AI"}</Button>
      </header>
      <StepBar steps={steps} current={step}/>

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: aiOpen ? "1fr 380px" : "1fr", overflow: "hidden" }}>
        <div style={{ overflowY: "auto", padding: "32px 40px 100px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            {step === 0 && <RaceStep race={race} setRace={setRace}/>}
            {step === 1 && <ClassStep cls={cls} setCls={setCls}/>}
            {step === 2 && <BackgroundStep bg={bg} setBg={setBg}/>}
            {step === 3 && <AbilitiesStep/>}
            {step === 4 && <SkillsStep cls={cls}/>}
            {step === 5 && <EquipmentStep cls={cls}/>}
            {step === 6 && <IdentityStep/>}
          </div>
        </div>
        {aiOpen && <AiBuilderPane step={steps[step]}/>}
      </div>

      <footer style={{ display: "flex", justifyContent: "space-between", padding: "16px 32px", borderTop: "1px solid var(--border)", background: "var(--bg-elev)" }}>
        <Button variant="ghost" size="md" disabled={step === 0} onClick={() => setStep(s => s - 1)} icon="arrow-left">Back</Button>
        <div style={{ fontSize: 12, color: "var(--fg-subtle)", alignSelf: "center" }}>Step {step + 1} of {steps.length}</div>
        {step < steps.length - 1 ? (
          <Button variant="primary" size="md" iconRight="arrow-right" onClick={() => setStep(s => s + 1)}>Next: {steps[step + 1]}</Button>
        ) : (
          <Button variant="accent" size="md" icon="check" onClick={onDone}>Save character</Button>
        )}
      </footer>
    </div>
  );
};

const races = [
  { slug: "human", name: "Human", note: "+1 to all abilities. Versatile, common." },
  { slug: "half-elf", name: "Half-Elf", note: "+2 CHA, +1 to two others. At ease everywhere." },
  { slug: "elf", name: "Elf", note: "+2 DEX. Keen senses, fey ancestry." },
  { slug: "dwarf", name: "Dwarf", note: "+2 CON. Stoneborn, resilient." },
  { slug: "halfling", name: "Halfling", note: "+2 DEX. Lucky, brave." },
  { slug: "tiefling", name: "Tiefling", note: "+2 CHA, +1 INT. Infernal heritage." },
  { slug: "dragonborn", name: "Dragonborn", note: "+2 STR, +1 CHA. Breath weapon." },
  { slug: "gnome", name: "Gnome", note: "+2 INT. Curious, magical." },
];

const classes_ = [
  { slug: "fighter", name: "Fighter", note: "Master of weapons, armor and tactics. d10 hit die." },
  { slug: "rogue", name: "Rogue", note: "Stealth, sneak attack, expertise. d8." },
  { slug: "wizard", name: "Wizard", note: "Arcane scholar. Spellbook. d6." },
  { slug: "cleric", name: "Cleric", note: "Divine caster. Channel Divinity. d8." },
  { slug: "ranger", name: "Ranger", note: "Hunter, tracker, half-caster. d10." },
  { slug: "barbarian", name: "Barbarian", note: "Rage, reckless attacks. d12." },
  { slug: "sorcerer", name: "Sorcerer", note: "Innate caster. Metamagic. d6." },
  { slug: "warlock", name: "Warlock", note: "Pact magic, eldritch invocations. d8." },
];

const backgrounds = [
  { slug: "soldier", name: "Soldier", skills: "Athletics, Intimidation" },
  { slug: "acolyte", name: "Acolyte", skills: "Insight, Religion" },
  { slug: "sage", name: "Sage", skills: "Arcana, History" },
  { slug: "criminal", name: "Criminal", skills: "Deception, Stealth" },
  { slug: "folk-hero", name: "Folk Hero", skills: "Animal Handling, Survival" },
  { slug: "outlander", name: "Outlander", skills: "Athletics, Survival" },
];

const StepHeader = ({ title, sub }) => (
  <>
    <h2 style={{ fontSize: 28, fontWeight: 600, marginBottom: 6 }}>{title}</h2>
    <p style={{ color: "var(--fg-muted)", fontSize: 14, marginBottom: 24, lineHeight: 1.55 }}>{sub}</p>
  </>
);

const Tile = ({ name, note, selected, onClick, accent = "var(--arcane)" }) => (
  <button onClick={onClick} style={{
    textAlign: "left", padding: 14, borderRadius: 8,
    background: "var(--bg-card)",
    border: selected ? `2px solid ${accent}` : "1px solid var(--border)",
    cursor: "pointer", fontFamily: "inherit", color: "inherit",
    display: "flex", flexDirection: "column", gap: 4,
  }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600 }}>{name}</div>
      {selected && <Icon name="check" size={16} style={{ color: accent }}/>}
    </div>
    <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.45 }}>{note}</div>
  </button>
);

const RaceStep = ({ race, setRace }) => (
  <div>
    <StepHeader title="Choose a race" sub="Each race grants ability score increases and innate traits."/>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 12 }}>
      {races.map(r => <Tile key={r.slug} name={r.name} note={r.note} selected={r.slug === race} onClick={() => setRace(r.slug)}/>)}
    </div>
  </div>
);

const ClassStep = ({ cls, setCls }) => (
  <div>
    <StepHeader title="Choose a class" sub="Your class shapes hit points, proficiencies, and the loop of play."/>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: 12 }}>
      {classes_.map(c => <Tile key={c.slug} name={c.name} note={c.note} selected={c.slug === cls} onClick={() => setCls(c.slug)} accent="var(--ember)"/>)}
    </div>
  </div>
);

const BackgroundStep = ({ bg, setBg }) => (
  <div>
    <StepHeader title="Background" sub="A scrap of past — two skill proficiencies, a feature, a starting bond."/>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: 12 }}>
      {backgrounds.map(b => <Tile key={b.slug} name={b.name} note={b.skills} selected={b.slug === bg} onClick={() => setBg(b.slug)} accent="var(--gold)"/>)}
    </div>
  </div>
);

const AbilitiesStep = () => {
  const [scores] = React.useState({ STR: 15, DEX: 14, CON: 13, INT: 10, WIS: 12, CHA: 8 });
  const [method, setMethod] = React.useState("array");
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return (
    <div>
      <StepHeader title="Ability scores" sub="Strength carries gold; Dexterity dodges arrows. Pick a method."/>
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {[["array", "Standard array"], ["pointbuy", "Point buy"], ["roll", "Roll 4d6 drop lowest"]].map(([id, label]) => (
          <button key={id} onClick={() => setMethod(id)} style={{
            padding: "8px 14px", borderRadius: 999,
            background: method === id ? "var(--bone)" : "var(--bg-card)",
            color: method === id ? "var(--ink)" : "var(--fg)",
            border: "1px solid " + (method === id ? "var(--bone)" : "var(--border)"),
            cursor: "pointer", fontFamily: "inherit", fontSize: 13,
          }}>{label}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
        {Object.entries(scores).map(([k, v]) => {
          const mod = Math.floor((v - 10) / 2);
          return (
            <div key={k} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, textAlign: "center" }}>
              <Eyebrow>{k}</Eyebrow>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 600, marginTop: 8 }}>{v}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>{mod >= 0 ? "+" : ""}{mod}</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--fg-subtle)", textAlign: "right", fontFamily: "var(--font-mono)" }}>total {total} · racial bonuses applied next</div>
    </div>
  );
};

const SkillsStep = ({ cls }) => (
  <div>
    <StepHeader title="Skills" sub={`A ${cls} picks two skills from the class list. Background skills are added automatically.`}/>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
      {["Athletics", "Acrobatics", "Perception", "Insight", "Intimidation", "Survival", "Animal Handling", "Stealth"].map((s, i) => (
        <label key={s} style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>
          <input type="checkbox" defaultChecked={i < 2} style={{ accentColor: "var(--arcane)" }}/>
          <span style={{ fontSize: 14 }}>{s}</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>+{i < 2 ? 4 : 2}</span>
        </label>
      ))}
    </div>
  </div>
);

const EquipmentStep = ({ cls }) => (
  <div>
    <StepHeader title="Equipment" sub="Pick a starting kit or buy gear with your starting gold."/>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
      <Tile name="Soldier's pack" note="Chain mail, longsword & shield, light crossbow, 20 bolts, dungeoneer's pack." selected={true} onClick={() => {}} accent="var(--verdigris)"/>
      <Tile name="Roll for gold" note="5d4 × 10 gp. Buy what you like at market price." selected={false} onClick={() => {}} accent="var(--verdigris)"/>
    </div>
    <Eyebrow style={{ marginBottom: 8 }}>Your kit</Eyebrow>
    <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.8, color: "var(--fg-muted)" }}>
      ▸ Longsword <span style={{ color: "var(--fg-subtle)" }}>1d8 slashing · versatile</span><br/>
      ▸ Chain mail <span style={{ color: "var(--fg-subtle)" }}>AC 16 · stealth disadv.</span><br/>
      ▸ Shield <span style={{ color: "var(--fg-subtle)" }}>+2 AC</span><br/>
      &nbsp;&nbsp; Light crossbow ×1<br/>
      &nbsp;&nbsp; Crossbow bolts ×20<br/>
      &nbsp;&nbsp; Dungeoneer's pack
    </div>
  </div>
);

const IdentityStep = () => (
  <div>
    <StepHeader title="Identity" sub="The last brushstrokes — name, alignment, the shape of a person."/>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <Field label="Name"><Input defaultValue="Tharion"/></Field>
      <Field label="Alignment">
        <select style={{ background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "9px 12px", fontFamily: "var(--font-ui)", fontSize: 14 }}>
          <option>Lawful Good</option><option>Neutral Good</option><option>Chaotic Good</option>
          <option>Lawful Neutral</option><option selected>True Neutral</option><option>Chaotic Neutral</option>
        </select>
      </Field>
      <Field label="Trait" style={{ gridColumn: "1 / -1" }}><Input defaultValue="I face problems head-on. A simple, direct solution is the best path to success."/></Field>
      <Field label="Bond" style={{ gridColumn: "1 / -1" }}><Input defaultValue="I would lay down my life for the people I served with."/></Field>
      <Field label="Flaw" style={{ gridColumn: "1 / -1" }}><Input defaultValue="I have little respect for anyone who is not a proven warrior."/></Field>
      <Field label="Backstory" style={{ gridColumn: "1 / -1" }}><TextArea rows={4} defaultValue="Conscripted at sixteen. Three years on the frontier with the Marcher Guard. The war ended; the woods didn't."/></Field>
    </div>
  </div>
);

const AiBuilderPane = ({ step }) => (
  <aside style={{ borderLeft: "1px solid var(--border)", background: "var(--bg-elev)", padding: 20, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Icon name="sparkle" size={18} style={{ color: "var(--arcane)" }}/>
      <Eyebrow>AI Builder · {step}</Eyebrow>
    </div>
    <p style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>Describe the character you have in mind. The Master will propose a value and explain it.</p>
    <TextArea rows={3} defaultValue="Wandering scout, raised in a port city, more comfortable with people than with the wild." style={{ fontSize: 13 }}/>
    <Button variant="primary" size="sm" icon="sparkle">Propose</Button>

    <div style={{ marginTop: 8, padding: 14, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <Chip tone="accent">Proposal · Half-Elf</Chip>
      <p style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.5, color: "var(--fg)" }}>
        <em>Half-Elf</em> matches a port-city upbringing — at ease among many peoples. The +2 Charisma and two free +1s give flexibility for a class that leans on social skills.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="secondary" size="sm">Edit</Button>
        <Button variant="primary" size="sm" icon="check">Accept</Button>
      </div>
    </div>

    <div style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--border)" }}>
      <Button variant="ghost" size="sm" icon="sparkle" style={{ width: "100%" }}>Build entire character</Button>
      <p style={{ marginTop: 6, fontSize: 11, color: "var(--fg-subtle)", textAlign: "center" }}>Run all 7 steps in sequence. Final review before save.</p>
    </div>
  </aside>
);

window.CharacterWizard = CharacterWizard;
