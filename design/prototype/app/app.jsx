// App — top-level navigation across all screens, plus Tweaks
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "obsidian",
  "accent": "arcane",
  "gameMode": "combat",
  "lobbyMode": "remote-mp",
  "wizardKind": "campaign",
  "showAiPane": true
}/*EDITMODE-END*/;

const ACCENTS = {
  arcane:    { "--arcane": "#7A4FB8", "--arcane-2": "#9C73D6" },
  dragonfire:{ "--arcane": "#D7331C", "--arcane-2": "#F0533A" },
  verdigris: { "--arcane": "#2D8F6F", "--arcane-2": "#5CAF8E" },
  gold:      { "--arcane": "#B5912E", "--arcane-2": "#E0B84A" },
};

const App = () => {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = React.useState({ name: "landing" });

  // Apply theme + accent
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("scribe", tweaks.theme === "scribe");
    const a = ACCENTS[tweaks.accent] || ACCENTS.arcane;
    Object.entries(a).forEach(([k, v]) => root.style.setProperty(k, v));
  }, [tweaks.theme, tweaks.accent]);

  const go = (name, payload) => setRoute({ name, ...payload });

  const screen = (() => {
    switch (route.name) {
      case "landing":
        return <LandingScreen onStart={() => go("hub")}/>;
      case "hub":
        return <HubScreen
          onLanding={() => go("landing")}
          onOpenCampaign={(id) => {
            const c = { hollowcreek: { title: "The Mill at Hollowcreek", mode: "solo" },
                        lanterns: { title: "Le Lanterne di Velmora", mode: "local-mp" },
                        ironroot: { title: "The Ironroot Vault", mode: "remote-mp" } }[id]
                  || { title: "Campaign", mode: "solo" };
            go("lobby", { campaign: c });
          }}
          onNewCampaign={() => go("campaign-wizard")}
          onNewCharacter={() => go("character-wizard")}
          onOpenCharacter={() => go("character-wizard")}
        />;
      case "campaign-wizard":
        return <CampaignWizard onCancel={() => go("hub")} onCreate={(payload) => go("lobby", { campaign: { title: "New campaign", mode: payload.mode } })}/>;
      case "character-wizard":
        return <CharacterWizard onCancel={() => go("hub")} onDone={() => go("hub")}/>;
      case "lobby":
        if (route.campaign?.mode === "solo") {
          return <GameScreen campaign={route.campaign} mode="solo" gameMode={tweaks.gameMode} onExit={() => go("hub")}/>;
        }
        return <MultiplayerLobby campaignId="" mode={route.campaign?.mode || tweaks.lobbyMode} onStart={() => go("game", { campaign: route.campaign })} onBack={() => go("hub")}/>;
      case "game":
        return <GameScreen campaign={route.campaign} mode={route.campaign?.mode || "solo"} gameMode={tweaks.gameMode} onExit={() => go("hub")}/>;
      default:
        return <LandingScreen onStart={() => go("hub")}/>;
    }
  })();

  return (
    <>
      {/* Quick nav rail (always visible, top-right floating) */}
      <NavRail route={route.name} go={go}/>
      {screen}
      <TweaksPanel title="Tweaks">
        <TweakSection title="Theme">
          <TweakRadio label="Mode" value={tweaks.theme} options={[["obsidian","Obsidian"],["scribe","Scribe"]]} onChange={v => setTweak("theme", v)}/>
          <TweakRadio label="Accent" value={tweaks.accent} options={[["arcane","Arcane"],["dragonfire","Fire"],["verdigris","Patina"],["gold","Gold"]]} onChange={v => setTweak("accent", v)}/>
        </TweakSection>
        <TweakSection title="Game screen state">
          <TweakRadio label="Mode" value={tweaks.gameMode} options={[["combat","Combat"],["exploration","Explore"],["spell","Spell"]]} onChange={v => setTweak("gameMode", v)}/>
        </TweakSection>
        <TweakSection title="Lobby variant">
          <TweakRadio label="Player setup" value={tweaks.lobbyMode} options={[["remote-mp","Remote"],["local-mp","Local"]]} onChange={v => setTweak("lobbyMode", v)}/>
          <TweakButton onClick={() => setRoute({ name: "lobby", campaign: { title: "Preview Lobby", mode: tweaks.lobbyMode } })}>Open lobby preview</TweakButton>
        </TweakSection>
        <TweakSection title="Jump to screen">
          <TweakButton onClick={() => go("landing")}>Landing</TweakButton>
          <TweakButton onClick={() => go("hub")}>Hub · Campaigns</TweakButton>
          <TweakButton onClick={() => go("campaign-wizard")}>Campaign wizard</TweakButton>
          <TweakButton onClick={() => go("character-wizard")}>Character wizard</TweakButton>
          <TweakButton onClick={() => go("game", { campaign: { title: "Preview", mode: "solo" } })}>Solo game</TweakButton>
          <TweakButton onClick={() => go("game", { campaign: { title: "Le Lanterne di Velmora", mode: "local-mp" } })}>Local-MP game</TweakButton>
          <TweakButton onClick={() => go("game", { campaign: { title: "The Ironroot Vault", mode: "remote-mp" } })}>Remote-MP game</TweakButton>
        </TweakSection>
      </TweaksPanel>
    </>
  );
};

const NavRail = ({ route, go }) => {
  const items = [
    { key: "landing", label: "Landing", icon: "logo-d20" },
    { key: "hub", label: "Hub", icon: "book" },
    { key: "campaign-wizard", label: "New campaign", icon: "plus" },
    { key: "character-wizard", label: "New character", icon: "user" },
    { key: "game", label: "Game", icon: "dice" },
  ];
  return (
    <div style={{
      position: "fixed", left: 12, bottom: 12, zIndex: 50,
      display: "flex", flexDirection: "column", gap: 4,
      background: "rgba(24, 19, 31, 0.92)", backdropFilter: "blur(12px)",
      border: "1px solid var(--border-strong)", borderRadius: 10, padding: 6,
      boxShadow: "var(--shadow-3)",
    }}>
      {items.map(it => (
        <button key={it.key} onClick={() => go(it.key, it.key === "game" ? { campaign: { title: "Preview", mode: "solo" } } : undefined)} title={it.label}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
            background: route === it.key ? "rgba(122,79,184,0.22)" : "transparent",
            color: route === it.key ? "var(--arcane-2)" : "var(--fg-muted)",
            border: "none", borderRadius: 6, cursor: "pointer",
            fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: 500,
          }}>
          <Icon name={it.icon} size={13}/> {it.label}
        </button>
      ))}
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(<App/>);
