// GameScreen — three-pane game session, with mode-aware variations
const GameScreen = ({ campaign, mode = "solo", gameMode = "combat", onExit }) => {
  const [messages, setMessages] = React.useState(() => initialMessages(gameMode));
  const [busy, setBusy] = React.useState(false);
  const [state, setState] = React.useState({ hp: 21, conditions: gameMode === "combat" ? ["Bloodied"] : [] });
  const [spellOpen, setSpellOpen] = React.useState(false);

  React.useEffect(() => {
    setMessages(initialMessages(gameMode));
    setState({ hp: gameMode === "combat" ? 21 : 27, conditions: gameMode === "combat" ? ["Bloodied"] : [] });
  }, [gameMode]);

  const send = (text) => {
    setMessages(m => [...m, { role: "player", who: currentPlayer(mode), content: text }]);
    setBusy(true);
    setTimeout(() => {
      setMessages(m => [...m, replyFor(text, gameMode)]);
      setBusy(false);
    }, 1100);
  };

  const character = gameCharacters[mode === "remote-mp" ? "dorn" : mode === "local-mp" ? "bria" : "tharion"];

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 24px", borderBottom: "1px solid var(--border)", background: "var(--bg-elev)", flexShrink: 0 }}>
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onExit}>Campaigns</Button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontSize: 17 }}>{campaign?.title || "The Mill at Hollowcreek"}</div>
          <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", marginTop: 1 }}>SESSION 1 · {gameMode.toUpperCase()} · LANG IT</div>
        </div>
        {mode !== "solo" && <PartyStrip mode={mode}/>}
        <Chip tone="accent" dot>SSE live</Chip>
        <Button variant="ghost" size="sm" icon="more"/>
      </header>

      {mode === "local-mp" && (
        <div style={{ background: "linear-gradient(90deg, transparent, rgba(215,51,28,0.18), transparent)", borderBottom: "1px solid rgba(215,51,28,0.4)", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#F0533A", animation: "pulse 1.6s ease-in-out infinite" }}/>
          <span style={{ fontSize: 13, fontFamily: "var(--font-display)", fontStyle: "italic" }}>Pass the device — <strong style={{ fontStyle: "normal" }}>Bria</strong>'s turn</span>
          <Button variant="ghost" size="sm">Switch player</Button>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <CharacterPane character={character} state={state}/>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
          <NarrativePane messages={messages} onSend={send} busy={busy} mode={mode} gameMode={gameMode} onSpell={() => setSpellOpen(true)}/>
          {spellOpen && <SpellModal onClose={() => setSpellOpen(false)}/>}
        </div>
        <MechanicsPane combat={gameMode === "combat" ? combatState : null} diceLog={diceLogData} scene={sceneFor(gameMode)} gameMode={gameMode}/>
      </div>
    </div>
  );
};

const PartyStrip = ({ mode }) => {
  const party = mode === "remote-mp"
    ? [{ n: "Dorn", c: "#B5A48A", on: true, you: true }, { n: "Sera", c: "#D7331C", on: true }, { n: "Quill", c: "#7A4FB8", on: false }, { n: "Mira", c: "#E0B84A", on: true }]
    : [{ n: "Bria", c: "#9C73D6", on: true, current: true }, { n: "Korvan", c: "#F0533A", on: true }, { n: "Aelis", c: "#2D8F6F", on: true }];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {party.map(p => (
        <div key={p.n} title={p.n} style={{
          width: 28, height: 28, borderRadius: "50%", background: p.c, color: "var(--ink)",
          fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
          opacity: p.on === false ? 0.35 : 1,
          outline: p.current || p.you ? "2px solid var(--gold)" : "none", outlineOffset: 1,
          position: "relative",
        }}>
          {p.n[0]}
          {p.on === false && <span style={{ position: "absolute", bottom: -2, right: -2, width: 8, height: 8, borderRadius: "50%", background: "var(--fg-subtle)", border: "1.5px solid var(--bg-elev)" }}/>}
        </div>
      ))}
    </div>
  );
};

const gameCharacters = {
  tharion: {
    name: "Tharion", race: "Half-Elf", cls: "Fighter", level: 3, hpMax: 27, ac: 16, speed: 30, pb: 2,
    abilities: { STR: 15, DEX: 14, CON: 13, INT: 10, WIS: 12, CHA: 8 },
    resources: [{ name: "Second Wind", cur: 1, max: 1 }, { name: "Action Surge", cur: 0, max: 1 }, { name: "Hit Dice (d10)", cur: 3, max: 3 }],
    inventory: [{ name: "Longsword", qty: 1, equipped: true }, { name: "Shortbow", qty: 1, equipped: false }, { name: "Chain mail", qty: 1, equipped: true }, { name: "Arrows", qty: 18, equipped: false }, { name: "Healer's kit", qty: 1, equipped: false }, { name: "Rations", qty: 4, equipped: false }],
  },
  bria: {
    name: "Bria", race: "Tiefling", cls: "Sorcerer", level: 2, hpMax: 14, ac: 12, speed: 30, pb: 2,
    abilities: { STR: 8, DEX: 14, CON: 13, INT: 12, WIS: 11, CHA: 16 },
    resources: [{ name: "Sorcery points", cur: 2, max: 2 }, { name: "Hit Dice (d6)", cur: 2, max: 2 }],
    inventory: [{ name: "Quarterstaff", qty: 1, equipped: true }, { name: "Component pouch", qty: 1, equipped: true }, { name: "Daggers", qty: 2, equipped: false }, { name: "Spellbook", qty: 1, equipped: false }],
  },
  dorn: {
    name: "Dorn", race: "Hill Dwarf", cls: "Cleric", level: 1, hpMax: 11, ac: 18, speed: 25, pb: 2,
    abilities: { STR: 14, DEX: 10, CON: 15, INT: 10, WIS: 16, CHA: 12 },
    resources: [{ name: "Channel Divinity", cur: 1, max: 1 }, { name: "Hit Dice (d8)", cur: 1, max: 1 }],
    inventory: [{ name: "Warhammer", qty: 1, equipped: true }, { name: "Chain mail", qty: 1, equipped: true }, { name: "Shield", qty: 1, equipped: true }, { name: "Holy symbol", qty: 1, equipped: true }, { name: "Healer's kit", qty: 1, equipped: false }],
  },
};

const initialMessages = (m) => {
  if (m === "exploration") return [
    { role: "master", content: "The corridor narrows. A draft slips past you, smelling of wet stone and woodsmoke. Three goblins crouch around a low fire ten paces ahead — they have not seen you yet." },
    { role: "system", content: "Master suggests: Stealth check, or declare an action." },
  ];
  if (m === "spell") return [
    { role: "master", content: "The warren opens into a low chamber. Six goblins, a bugbear at the back. They turn at once. <em>Roll initiative.</em>" },
    { role: "player", who: "you", content: "I cast Magic Missile at the bugbear." },
    { role: "system", content: "Pick a spell slot →" },
  ];
  // combat default
  return [
    { role: "master", content: "Steel glints by firelight. Your blade finds the first goblin; he crumples without a sound. The other two leap up, screeching.", tools: [
      { tool: "make_attack", formula: "1d20+5", result: "18 vs AC 13", status: "ok" },
      { tool: "apply_damage", formula: "1d8+3", result: "9 slashing", status: "ok" },
    ]},
    { role: "player", who: "you", content: "I move to flank the chieftain and swing again." },
    { role: "master", content: "You step over the corpse. The chieftain bares his teeth and meets your blow with a rusted scimitar — a clatter, and your sword finds nothing but iron.", tools: [
      { tool: "make_attack", formula: "1d20+5 vs AC 15", result: "12 — miss", status: "ok" },
    ]},
    { role: "system", content: "Goblin Chief reacts. Initiative 15." },
  ];
};

const replyFor = (text, gameMode) => ({
  role: "master",
  content: gameMode === "spell"
    ? "Three darts of arcane force lance from your fingertips and strike the bugbear in the chest. He staggers but does not fall. Your slot is spent. Initiative passes to <em>Korvan</em>."
    : "The chieftain bares his teeth and hurls a javelin. <em>It catches you in the shoulder.</em> You stagger but stay on your feet — your turn.",
  tools: gameMode === "spell"
    ? [{ tool: "cast_spell", formula: "magic-missile · slot 1", result: "3 darts · 11 force", status: "ok" }]
    : [{ tool: "make_attack", formula: "1d20+3", result: "14 vs AC 16 — hit", status: "ok" }, { tool: "apply_damage", formula: "1d6+1", result: "5 piercing", status: "ok" }],
});

const sceneFor = (m) => m === "exploration" ? "Underground passage, mill cellar. Single torch. Three goblins ahead, unaware." : m === "spell" ? "Low warren chamber. Initiative just rolled. Six goblins, one bugbear." : "Goblin warren beneath the mill, dimly lit. Round 3. The chieftain blocks the only door.";

const currentPlayer = (mode) => mode === "remote-mp" ? "Dorn" : mode === "local-mp" ? "Bria" : "you";

const combatState = {
  round: 3,
  actors: [
    { name: "Tharion", init: 18, hp: 21, hpMax: 27, alive: true, current: true },
    { name: "Goblin Chief", init: 15, hp: 12, hpMax: 21, alive: true },
    { name: "Goblin scout", init: 12, hp: 4, hpMax: 7, alive: true },
    { name: "Goblin scout", init: 9, hp: 0, hpMax: 7, alive: false },
  ],
};

const diceLogData = [
  { kind: "init",   formula: "1d20+2", total: 18, note: "Tharion" },
  { kind: "attack", formula: "1d20+5", total: 18, note: "vs goblin AC 13 — hit" },
  { kind: "damage", formula: "1d8+3",  total: 9,  note: "slashing" },
  { kind: "attack", formula: "1d20+4", total: 11, note: "vs Tharion AC 16 — miss", fail: true },
  { kind: "save",   formula: "1d20+1", total: 7,  note: "DC 13 CON — failed", fail: true },
  { kind: "attack", formula: "1d20+5", total: 20, note: "natural 20", crit: true },
  { kind: "damage", formula: "2d8+3",  total: 14, note: "slashing — crit" },
];

window.GameScreen = GameScreen;
