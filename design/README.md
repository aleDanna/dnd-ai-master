# Handoff: D&D AI Master

## Overview

**D&D AI Master** is a web app that lets players run full D&D 5e campaigns with an AI Dungeon Master. It supports three play modes — **Solo** (one player + AI DM), **Local pass-and-play** (multiple players sharing one device + AI DM), and **Remote multiplayer** (separate devices in a shared room + AI DM). The AI handles narration, NPC voicing, scene description, rules adjudication, and dice rolls; players act through chat plus structured controls (attack, cast spell, end turn, skill check).

This bundle contains an end-to-end click-through prototype covering: marketing landing → hub (campaigns + characters) → campaign creation wizard (4 steps, 3 styles, 3 modes) → character creation wizard (7 steps, with an AI Builder side pane) → multiplayer lobby (remote + local variants) → game screen (3-pane: character sheet, narrative, mechanics) with combat tracker, dice log, and spell-slot modal.

## About the Design Files

The files in `prototype/` are **design references created in HTML/React-via-Babel** — running prototypes that show intended look, layout, and behavior. They are NOT production code to copy directly. Your task is to **recreate these designs in the target codebase's existing environment** using its established patterns, component library, routing, and state management.

The prototype loads React and JSX-via-Babel from CDNs purely so the design could be presented as a single static page. In a real app you would:
- Use the codebase's existing React (or Vue/Svelte/etc.) build pipeline.
- Replace inline-style JSX with the codebase's styling system (CSS Modules, Tailwind, styled-components, vanilla-extract — whatever is already in use).
- Use the codebase's icon system instead of the inline `<Icon>` SVG component.
- Wire real state management (Zustand, Redux, Context, server state via React Query/tRPC) for sessions, characters, campaigns, and live multiplayer.
- Wire the AI DM to a real LLM backend (the prototype's `replyFor` is a placeholder).

If the project has no existing frontend, pick the most appropriate framework (Next.js + React + Tailwind is a reasonable default for this kind of app) and implement the designs there.

There is also a written MVP spec at `dnd-ai-master/docs/superpowers/specs/2026-05-02-dnd-ai-master-mvp-design.md` in the original project — read it for the product/engineering vision (data model, AI tool-calling, SRD knowledge base, game engine).

## Fidelity

**High-fidelity.** The prototype is pixel-accurate within the AI&Games / D&D AI Master design system: final colors, typography, spacing, radii, shadows, copy, and interactive states. Recreate it pixel-perfectly using the codebase's libraries — do not redesign.

The prototype already uses the design system's CSS variables (`colors_and_type.css`). Your codebase should adopt the same tokens, either by importing this file directly, generating equivalent Tailwind theme tokens, or porting them into the existing token system.

## Screens / Views

### 1. Landing (`screens-marketing.jsx`)
- **Purpose**: Marketing entry. Pitch the three play modes (solo, local, remote) and route to the hub.
- **Layout**: Single full-height obsidian background. Centered hero block at ~60% width: small eyebrow ("D&D AI Master"), display headline (~64px), subhead, primary CTA button "Enter the table", secondary "Browse my campaigns". Below, a 3-column grid of `ModeTile` cards for the three modes (icon + title + 1-line description). Footer line with version + signature glyph.
- **Components**: hero text block, primary/secondary buttons (see Components > Button), `ModeTile` (icon top-left, title H3, body text 14px, accent border-top stripe).

### 2. Hub (`screens-hub.jsx`)
- **Purpose**: Unified list of active campaigns + saved characters; entry point to wizards.
- **Layout**: Top bar (logo + nav + "New campaign" CTA). Two stacked sections, each preceded by a `SectionHeader` (eyebrow + title + count). 
  - **Campaigns**: 3-column grid of `CampaignCard` (cover/glyph, title, mode chip, style chip, status chip, last-scene one-liner, last-played timestamp).
  - **Characters**: 4-column grid of `CharacterCard` (round portrait dot in character color, name, race · class · level, HP bar, AC mini-stat, current campaign).
- **Empty states**: A dashed-border tile labeled "+ New campaign" / "+ New character" trails each grid.

### 3. Campaign Wizard (`screens-campaign-wizard.jsx`)
- **Purpose**: Create a new campaign. 4 steps.
- **Layout**: 2-pane: left 720px content column with step header + step body + "Back / Next" footer; right 360px summary rail showing accumulating choices ("Mode: Solo", "Style: Improv", etc.). Top progress bar with 4 dots.
- **Steps**:
  1. **Mode** — three big `BigChoice` cards: Solo / Local pass-and-play / Remote room. Each with icon, title, 2-line desc.
  2. **Style** — three `BigChoice` cards: Module (curated published adventure) / Improv (AI invents premise from prompt) / Hybrid. Module shows a sub-grid of preset modules; Improv shows a tone picker (chips: Classic fantasy, Dark/horror, Whimsical, Political intrigue, Sword & sandal); Hybrid shows both.
  3. **Party** — depends on mode. Solo: pick one character from existing list or "Create new". Local-MP: 2–6 seat slots, each with name input and color picker. Remote-MP: shareable invite link block + seat preview.
  4. **Premise** — for Improv: long textarea ("In a sentence, what's the campaign about?") + difficulty slider + starting-level select. For Module: review screen with module summary, party roster, and "Begin" button.
- **Components**: `BigChoice` (selected state = arcane border + arcane-tinted background), `Row` (k/v pair in summary rail), tone chip, slider, primary/secondary buttons.

### 4. Character Wizard (`screens-character-wizard.jsx`)
- **Purpose**: Create a 5e character. 7 steps with an **AI Builder** side pane.
- **Layout**: 3-pane: left 200px step rail (numbered list of 7 steps with current highlighted), center content column with step header + step body + footer, right 320px `AiBuilderPane` (collapsible) — chat-style helper that suggests choices, fills steps via natural language ("Make me a charismatic half-elf paladin who used to be a sailor").
- **Steps**: Race, Class, Background, Abilities, Skills, Equipment, Identity. Each step's main area is a vertical list of `Tile`s with name + flavor note; selected = arcane border. Abilities step has a method tab (Standard array / Point buy / Roll 4d6) and a 6-stat grid (STR/DEX/CON/INT/WIS/CHA, big number + modifier underneath). Identity step is a small form (name, alignment dropdown, pronouns, portrait color).

### 5. Multiplayer Lobby (`screens-lobby.jsx`)
- **Purpose**: Pre-game waiting room for local + remote multiplayer.
- **Layout**: Full-bleed obsidian with centered card. Top: campaign title + mode chip + "Copy invite" pill (remote only) showing a shareable code. Middle: grid of `SeatCard`s — one per player. Each seat shows portrait dot, name, race·class·level, ready/joining/empty status chip. Bottom: DM-readiness summary ("3 of 4 players ready"), "Start session" primary button (disabled until all ready or DM forces start), "Cancel" secondary.
- **Variants**: Local pass-and-play hides invite link, shows only the seats that were configured in the wizard, and uses a "tap to claim seat" interaction pattern.

### 6. Game Screen (`screens-game.jsx` + `pane-*.jsx`)
- **Purpose**: The actual play surface. 3-pane layout, persistent.
- **Layout**: Top bar: logo + campaign title + mode chip + party strip (avatars + "currently acting: X" indicator) + exit button. Below, three columns:
  - **Left 320px — Character pane** (`pane-character.jsx`): portrait, name + race/class/level, HP bar with current/max, AC + Speed + Initiative + Proficiency mini-stats, 6 ability scores in a 2×3 grid (score + modifier), proficiencies/skills accordion, inventory accordion, conditions row.
  - **Center fluid — Narrative pane** (`pane-narrative.jsx`): scrolling chat log with role-styled messages (DM = serif body, large; Player = ui-sans, right-aligned bubble; Tool = compact pill showing dice formula + result + ok/err status), composer at bottom (textarea + Send button + quick-action chips: Attack, Cast spell, Skill check, Recap). When `gameMode = "spell"`, a centered `SpellModal` appears (spell-slot picker grid: levels 1–9 with used/total dots, "Cast" button).
  - **Right 320px — Mechanics pane** (`pane-mechanics.jsx`): three stacked sections — Combat tracker (initiative order list, current actor highlighted, round counter), Dice log (last 6 rolls, kind+formula+total+note), Scene one-liner. Combat tracker hides when `gameMode = "exploration"`.
- **States**: combat / exploration / spell. Toggleable via Tweaks for review.

## Interactions & Behavior

- **Routing**: top-level state `route = { name, ...payload }`; transitions are imperative (`go("hub")`). In a real app, use the codebase's router (Next.js App Router, React Router, etc.) with URLs like `/hub`, `/campaigns/new`, `/characters/new`, `/c/:id/lobby`, `/c/:id/play`.
- **Wizards**: unsaved progress should persist locally per session (the prototype only holds it in component state).
- **Send message** (Narrative pane): sets `busy=true`, appends a player message, calls AI, appends DM reply. Real impl streams tokens.
- **Tool calls**: when AI calls a tool (e.g. `roll_attack`), render a `ToolPill` in the chat with a spinning-d20 placeholder until the result lands, then animate to the final value.
- **Spell modal**: opens on Cast Spell quick action; slot grid; selecting a slot animates a slot dot to "used" and emits a chat message.
- **Multiplayer turn ownership**: the party strip indicates `currentPlayer`. Composer and quick-actions are disabled when it isn't this client's turn.
- **Hover/active/focus**: all clickable cards lift slightly (translateY -1px), border brightens to arcane on hover, focus ring is `2px solid var(--arcane-2)` with `2px` offset.
- **Animations**: spinning d20 (`@keyframes spin`, 1.2s linear infinite), pulsing busy dot (`@keyframes pulse`, 1.5s ease-in-out infinite), card hover transform (150ms ease-out).

## State Management

Suggested store shape (server-backed in production):

```ts
type Campaign = { id, title, mode: "solo"|"local-mp"|"remote-mp", style: "module"|"improv"|"hybrid", premise, partyIds: string[], createdAt, lastPlayedAt, scene: string }
type Character = { id, name, race, class, level, abilities: {STR,DEX,CON,INT,WIS,CHA}, hp, hpMax, ac, speed, proficiencies, skills, inventory, conditions, ownerId, color }
type Session = { id, campaignId, currentTurn: characterId, round: number, mode: "combat"|"exploration", initiative: characterId[] }
type Message = { id, role: "dm"|"player"|"tool", playerId?, content, toolCall?: {name, formula, result, status}, createdAt }
type Roll = { id, kind, formula, total, note, createdAt }
```

Live multiplayer needs a websocket layer (Pusher / Ably / Liveblocks / Convex / custom WS) for: turn changes, dice results, AI streaming, presence.

## Design Tokens

All tokens live in `prototype/colors_and_type.css`. Highlights:

**Colors (Obsidian theme — default):**
- `--bg-page` `#0E0B12` · `--bg-elev` `#18131F` · `--bg-card` `#1F1828` · `--bg-sunken` `#0A080D`
- `--fg` `#EFE7DA` · `--fg-muted` `#A99E8E` · `--fg-subtle` `#6F6557`
- `--border` `#2A2433` · `--border-strong` `#3A3245`
- Accents (themeable via `--arcane`/`--arcane-2`):
  - Arcane (default) `#7A4FB8` / `#9C73D6`
  - Dragonfire `#D7331C` / `#F0533A`
  - Verdigris `#2D8F6F` / `#5CAF8E`
  - Gold `#B5912E` / `#E0B84A`
- Status: `--ok` `#2D8F6F` · `--warn` `#E0B84A` · `--ember` `#D7331C`

**Scribe (light) theme** — applied via `.scribe` class on `<html>`. Parchment background, ink-on-paper foreground; same accents.

**Typography:**
- `--font-display`: serif, headline use (Cinzel-style quality desired; the prototype uses a stack)
- `--font-body`: serif body for DM narration
- `--font-ui`: sans-serif for buttons, labels, mechanics
- `--font-mono`: mono for dice formulas, codes
- Sizes: 11/12/13/14/16/20/28/32/48/64

**Spacing:** 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64

**Radii:** 4 / 6 / 8 / 10 / 12 / 999

**Shadows:** `--shadow-1` (subtle card), `--shadow-2` (popovers), `--shadow-3` (modals/lobby card)

## Components (shared primitives)

Located in `prototype/ui.jsx` and `prototype/app/components-base.jsx`:
- `Icon` — inline SVG icon set (`logo-d20`, `book`, `dice`, `user`, `sword`, `flame`, `shield`, `plus`, `chevron`, `check`, `x`, etc.). Replace with the codebase's icon library.
- `Button` — primary/secondary/ghost/danger; sizes sm/md/lg
- `Card` — bg-card surface with border + radius 10 + optional hover lift
- `Chip` — colored tone chips (accent/ok/warn/ember/gold/neutral); used for mode, style, status labels
- `Eyebrow` — small uppercased letter-spaced section label
- `TopBar` (in `components-base.jsx`) — used by hub + game screen; logo + nav + mode chip + actions

## Assets

- Logo SVGs are in the original project at `assets/logo-mark.svg`, `assets/logo-wordmark.svg`, `assets/logo-lockup.svg`. Replace placeholders with the production logo lockup.
- Character portraits are placeholder colored circles. Production should support either AI-generated portraits or uploaded images.
- Dice imagery is a single d20 SVG (rendered via `<Icon name="logo-d20"/>`). For richer polish, consider a 3D dice roll animation (e.g. `@3d-dice/dice-box`) gated to combat moments.

## Files

```
prototype/
  AI&Games.html              ← root entry; loads React + Babel + all jsx files
  colors_and_type.css        ← design tokens (port these)
  ui.jsx                     ← Icon, Button, Card, Chip, Eyebrow primitives
  tweaks-panel.jsx           ← in-prototype tweak controls (NOT for production)
  app/
    app.jsx                  ← top-level router + Tweaks wiring
    components-base.jsx      ← TopBar, NavRail
    screens-marketing.jsx    ← Landing
    screens-hub.jsx          ← Hub (campaigns + characters)
    screens-campaign-wizard.jsx
    screens-character-wizard.jsx
    screens-lobby.jsx
    screens-game.jsx         ← game screen shell + sample data
    pane-character.jsx
    pane-narrative.jsx
    pane-mechanics.jsx
```

To preview the prototype: open `prototype/AI&Games.html` in a browser (it needs to be served, not file://, because of the relative script imports — `npx serve prototype/` works).

## Out of scope for this handoff (but in the MVP spec)

- AI DM prompt engineering and tool-calling schema
- SRD knowledge base ingestion + retrieval
- Authoritative game engine for dice, conditions, spell slots, rest cycles
- Persistence (DB schema, sync, conflict resolution for local-MP)
- Voice / TTS for DM narration
- Mobile-responsive variants (designs above are desktop-first)

These belong to the implementation phase; the design captured here is the visual + interactive surface.
