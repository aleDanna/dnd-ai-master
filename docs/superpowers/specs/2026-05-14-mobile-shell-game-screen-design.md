# Mobile shell + Game screen — Design

**Status:** spec
**Phase:** 1 of 3 in the design-handoff implementation (mobile shell + game screen; hub/wizards/settings mobile come next)
**Authors:** Alessio
**Date:** 2026-05-14

## Context

The repo ships an existing Next.js app (App Router, Drizzle, Clerk, multi-provider AI) with a 3-pane desktop game surface. The `design_handoff_dnd_ai_master/prototype/` directory contains a high-fidelity React+Babel prototype that adds a **mobile counterpart** — single-pane chat with progressive disclosure via slide-up sheets, plus a bottom tab bar on hub-level screens.

The handoff's `README.md` (lines 211–220) is explicit:

> The cleanest path is **NOT** to fork desktop/mobile routes. Instead:
> 1. Add a `useIsMobile()` hook.
> 2. Each game-screen component already accepts forwardable props — extend their layout to switch on viewport.
> 3. Game-client becomes the orchestrator: on mobile, render only `NarrativePane` and stash `CharacterPane`/`MechanicsPane` inside drawers.
> 4. The `BottomNav` is new — wire it into `(authed)/layout.tsx` and hide it on session pages.

This spec covers **phase 1**: foundation primitives + the game screen mobile experience. Hub, settings, wizards, campaign detail and landing pages remain desktop-only on mobile for now (they render the desktop layout shrunk; visually wrong but functional). Phase 2 will cover the hub tabs + bottom nav routing; phase 3 will cover the remaining surfaces.

## Goals

1. Mobile users at ≤720px get a usable game screen that matches the prototype: single-pane chat, mini character bar, FAB for mechanics, drawers for full character/mechanics views.
2. Zero duplication of route or state-management logic between desktop and mobile.
3. SSR-safe: no hydration mismatch on first paint; brief desktop→mobile flash on mobile-first viewports is acceptable.
4. The bottom navigation foundation is in place — even though the game screen is the only "mobile-aware" surface in this phase, the layout shell is ready so phase 2 only has to wire the hub screens, not the chrome.

## Non-goals

- Hub / settings / wizards / campaign-detail / landing / invite mobile responsive (phase 2 + 3).
- UA-based SSR rendering (no server-side mobile detection).
- Touch-specific gestures beyond what `vaul` provides (no custom swipe handlers).
- Native app wrapping, push notifications, voice input, offline mode.

## Architecture

```
+--------------------------------------------------------+
| useIsMobile() — matchMedia('(max-width: 720px)')        |
+--------------------------------------------------------+
                       |
            +----------+----------+
            |                     |
+-----------v-----------+ +-------v-----------+
| (authed)/layout.tsx   | | game-client.tsx   |
| - session page:       | | - mobile:         |
|     children only     | |   own TopBarMobile|
|     (no chrome)       | |   + MiniCharBar   |
| - mobile + hub-route: | |   + PartyStrip    |
|     TopBarMobile      | |   + NarrativePane |
|     <children/>       | |   + FAB           |
|     BottomNav         | |   + Drawers (vaul)|
| - mobile + elsewhere: | | - desktop:        |
|     TopBarMobile      | |   own desktop hdr |
|     <children/>       | |   + 3-pane layout |
| - desktop:            | +-------------------+
|     TopBar            |
|     <children/>       |
+-----------------------+
```

State stays exactly where it is today: `GameClient` owns the session state machine (snapshot, memory ready, streaming, party, my-turn detection, …). On mobile it forwards the same props to `<NarrativePane>` (the always-visible center pane) and to the drawer-hosted `<CharacterPane>` / `<MechanicsPane>`.

## File-level changes

### New files

| Path | Purpose |
|---|---|
| `src/lib/use-is-mobile.ts` | Hook: `matchMedia('(max-width: 720px)')`. Returns `false` during SSR, real value after mount. |
| `src/components/ui/drawer.tsx` | Thin wrapper around `vaul` `<Drawer.Root>` with our preset styling (background `var(--bg-elev)`, top-radius 20, drag handle, scrim). |
| `src/components/layout/top-bar-mobile.tsx` | 44px sticky header. Slots: `leading` (back/menu icon), `title` + optional `subtitle`, `trailing` (icon buttons). |
| `src/components/layout/bottom-nav.tsx` | 3-tab fixed-bottom nav. Tabs: Campaigns (`/campaigns`), Heroes (`/hub`), Settings (`/settings`). Active tab gets `var(--arcane-2)`. Uses `usePathname()`. |
| `src/components/game/mobile-character-bar.tsx` | Sticky 56px bar under top bar: avatar / name+stats / HP bar / chevron-up. `onClick` prop opens the character drawer. |
| `src/components/game/mobile-mechanics-fab.tsx` | Floating button 48×48 bottom-right above composer. Icon switches by `gameMode` (`sword` combat, `compass` exploration). Optional round-number badge. |

### Modified files

| Path | Change |
|---|---|
| `src/components/ui/icon.tsx` | Add icon cases: `image`, `menu`, `copy`, `chevron-down`, `chevron-up`, `globe`, `compass`, `flame`, `star`, `eye`. Match existing stroke 1.5 / viewBox 24 style. |
| `src/app/(authed)/layout.tsx` | Convert to client component (or split with a small client wrapper) to use `useIsMobile()` + `usePathname()`. Skip the chrome top bar entirely for `/sessions/[id]` (the page has its own). Otherwise pick desktop vs mobile top bar. Render `<BottomNav/>` when mobile AND pathname in `{/hub, /campaigns, /settings}`. Add `paddingBottom: 72` to content when BottomNav is visible. |
| `src/app/(authed)/sessions/[id]/game-client.tsx` | Branch on `useIsMobile()`. Mobile renders: mobile top header + `MobileCharacterBar` + (existing) `PartyStrip` + `NarrativePane compact` + `MobileMechanicsFab` + character/mechanics Drawers. Desktop is unchanged. |
| `src/components/game/narrative-pane.tsx` | Accept `compact?: boolean`. When true: padding `16px 20px 100px` (was `32px 40px 80px`), quick-action bar hidden, composer padding tightened to `8px 16px 16px` (was `8px 40px 20px`). Send button label stays "Send" but size shrinks to `sm`. |
| `src/components/game/character-pane.tsx` | Accept `compact?: boolean`. When true: drop `position: sticky`, drop `width: 280`, drop `border-right`, `height` `auto`, padding stays 18. The pane becomes scrollable content inside a drawer. |
| `src/components/game/mechanics-pane.tsx` | Same `compact` pattern: no sticky, no width cap, no border-left. |
| `package.json` | Add `vaul` (latest stable). |

## Drawer primitive

`vaul` provides a Radix-based bottom drawer with native drag-to-dismiss. The wrapper exposes:

```tsx
<Drawer open={open} onOpenChange={setOpen}>
  <Drawer.Trigger asChild>{trigger}</Drawer.Trigger>
  <Drawer.Content>
    {children}
  </Drawer.Content>
</Drawer>
```

Styling preset:
- Content: `var(--bg-elev)` background, top-radius 20, `var(--border-strong)` top border
- Max-height: `88%` (default) or `60%` (`peek` prop)
- Drag handle: 36×4, `var(--fg-subtle)` at 0.4 opacity, centered
- Scrim: `rgba(0,0,0,0.55)` with `backdrop-filter: blur(4px)`
- Slide-up animation: `vaul` default (240ms ease-out)

We use it for the character drawer and mechanics drawer. Phase 3 (AI Builder, spell modal on mobile) reuses the same primitive.

## `useIsMobile()` hook

```ts
// src/lib/use-is-mobile.ts
import * as React from 'react';

export function useIsMobile(query = '(max-width: 720px)'): boolean {
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return isMobile;
}
```

SSR returns `false` (the initial state). On mount, the effect runs, the hook re-reads `matchMedia`, and re-renders if mobile. Acceptable hydration story: desktop layout is the SSR truth; mobile users see ~50ms of desktop chrome before the swap.

## Game screen mobile — composition

`game-client.tsx` (simplified mobile branch):

```tsx
const isMobile = useIsMobile();

if (isMobile) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      <TopBarMobile
        leading={<Link href="/sessions"><Button variant="ghost" size="sm" icon="arrow-left" /></Link>}
        title={campaign?.name ?? `${character.name}'s session`}
        subtitle={`${liveState.inCombat ? 'COMBAT' : 'EXPLORATION'} · ${(campaign?.language ?? session.language)?.toUpperCase() ?? '—'}${party.length > 1 ? ` · ${party.length}P` : ' · SOLO'}`}
        trailing={<><AutoplayToggle value={autoplay} onChange={setAutoplay} /><Button variant="ghost" size="sm" icon="more" /></>}
      />
      <MobileCharacterBar character={character} state={liveState} onOpen={() => setCharOpen(true)} />
      {snapshot && party.length > 1 && <PartyStrip party={party} currentPlayerCharacterId={...} viewerCharacterId={...} />}
      <NarrativePane {...narrativeProps} compact />
      <MobileMechanicsFab gameMode={liveState.inCombat ? 'combat' : 'exploration'} round={liveState.round} onOpen={() => setMechOpen(true)} />
      <Drawer open={charOpen} onOpenChange={setCharOpen}>
        <Drawer.Content><CharacterPane {...} compact /></Drawer.Content>
      </Drawer>
      <Drawer open={mechOpen} onOpenChange={setMechOpen}>
        <Drawer.Content><MechanicsPane {...} compact /></Drawer.Content>
      </Drawer>
      {spellOpen && character.spellcasting && <SpellModal {...} />}
    </div>
  );
}

// existing desktop layout
```

Sticky stacking on mobile (z-index):
- TopBarMobile: 20
- MobileCharacterBar: 19 (sits under top bar)
- PartyStrip: 18 (multiplayer only)
- NarrativePane composer: 5
- FAB: 6 (above composer, below drawer)
- Drawer scrim/content: 40+ (vaul defaults)

## BottomNav routing

```ts
const HUB_ROUTES = ['/hub', '/campaigns', '/settings'];
const isHubRoute = HUB_ROUTES.some((r) => pathname === r);
// exact match only — /campaigns/[id] does NOT show BottomNav
const showBottomNav = isMobile && isHubRoute;
```

Active-tab mapping:
- `/campaigns` → "Campaigns" tab
- `/hub` → "Heroes" tab
- `/settings` → "Settings" tab

Tap navigates via `<Link>`. The router transitions clientside; the layout re-renders, `usePathname` updates, the active dot moves.

## Hydration boundary

`(authed)/layout.tsx` is currently a server component. To use `useIsMobile()` it needs to be a client component. Options considered:

- **Option A** (chosen): Convert the entire `(authed)/layout.tsx` to client. It only renders chrome (TopBar) and `{children}` — no server data fetching.
- Option B: Keep layout as server, extract chrome into a separate `<AuthedChrome>` client component.

Option A is simpler. The layout doesn't fetch data today; flipping it to `'use client'` has no cost.

## Compact props — exact deltas

### NarrativePane

- Outer container padding: `32px 40px 80px` → `16px 20px 100px`
- Quick-action bar: hidden (return `null` for the whole `<div>` that holds the `<Quick>` buttons)
- Composer padding: `padding: '8px 40px 20px'` → `'8px 16px 16px'`
- Send button: keep "Send" label, switch from `size="md"` to `size="sm"` (the textarea sits next to it; on 393px we need ~80px less)
- Bottom padding of message area: `80px` → `100px` (FAB needs clearance above composer)

### CharacterPane

- Drop: `width: 280`, `borderRight`, `position: sticky`, `top: 56`, `height: calc(100vh - 56px)`, `overflowY: 'auto'`, `flexShrink: 0`, `background: 'var(--bg-elev)'`
- Keep: padding 18, internal layout, all sections
- The drawer's `Drawer.Content` provides background + scroll

### MechanicsPane

- Same as CharacterPane: drop `width: 320`, `borderLeft`, sticky/top/height, `overflowY`, `background`
- Keep: padding 18, internal layout, XP/travel/combat/dice/scene sections

## Icon additions

Glyphs to add in `icon.tsx`, all 24×24 viewBox, stroke 1.5:

- `image` — rect + sun + line (standard image icon)
- `menu` — 3 horizontal lines
- `copy` — two overlapping rounded rects
- `chevron-down` — `<polyline points="6 9 12 15 18 9"/>`
- `chevron-up` — `<polyline points="18 15 12 9 6 15"/>`
- `globe` — circle + two ellipses
- `compass` — circle + diamond needle
- `flame` — teardrop with inner curl
- `star` — 5-point star outline
- `eye` — almond + inner circle

Source for SVGs: use Feather Icons or Lucide as reference for path strings, adapted to current `<svg {...baseProps}>` pattern in `icon.tsx`. Lucide is MIT-licensed.

## Testing

Manual verification (no automated UI tests for mobile breakpoints in this repo yet):

1. **Resize the browser** to 393×852 (Chrome DevTools → iPhone 16 Pro): confirm `/sessions/[id]` flips to single-pane mode.
2. **Tap the mini character bar** → character drawer slides up, contains all sections (HP, AC, abilities, conditions, spells, currency, equipped, inventory, resources).
3. **Tap the FAB** → mechanics drawer slides up, contains XP, travel (when set), combat tracker, dice log, scene + image.
4. **Drag the drawer handle down** → drawer dismisses.
5. **Tap outside the drawer** → drawer dismisses.
6. **Resize back to 1280px** → desktop 3-pane layout returns; the same session, no state lost, drawers gone.
7. **Multiplayer**: confirm `PartyStrip` still sticky between mini-char-bar and chat.
8. **`/hub`, `/campaigns`, `/settings`** at 393px → BottomNav visible, active tab matches route, taps navigate.
9. **`/sessions/[id]`, `/campaigns/[id]`, `/campaigns/new`, `/characters/new`, `/r/[token]`** at 393px → BottomNav hidden.
10. **At desktop width**: BottomNav never appears.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `vaul` brings a Radix peer-dep conflict | Run `pnpm add vaul` in a worktree first; resolve before landing. |
| `useIsMobile` returns `false` during the first render → flash of desktop on real mobile devices | Accepted; documented. Phase 4 may revisit with UA-based SSR detection. |
| `(authed)/layout.tsx` turning client breaks an auth pattern | The current layout has zero server-side logic (no fetch, no auth call). The auth gate is in middleware + per-page server components. No risk. |
| Drawer scroll inside a flex parent on iOS Safari | `vaul` already handles iOS overscroll; verify in DevTools touch emulation. |
| Existing `NarrativePane` `scrollTo(window)` auto-scroll inside a mobile single-pane layout | Already scrolls `document.documentElement`. Works the same. |
| Icon additions break tree-shaking | The `switch (name)` pattern keeps everything in one file; tree-shaking is already disabled here. No regression. |

## Out of scope (explicit reminders)

- `/hub` page mobile (still renders desktop layout shrunk)
- `/campaigns/[id]` mobile
- Settings page mobile
- Both wizards mobile (campaign wizard, 7-step character wizard with AI Builder bottom sheet)
- Landing page mobile
- `/r/[token]` invite resolve mobile

These remain visually broken on mobile until phase 2 + 3. The game screen itself is the highest-value mobile surface and the focus of this phase.

## References

- `design_handoff_dnd_ai_master/README.md` — full handoff doc, especially the "Mobile design" and "Implementation guidance for mobile" sections.
- `design_handoff_dnd_ai_master/prototype/app/mobile-shell.jsx` — reference React+Babel implementation of MobileFrame / MobileTopBar / MobileBottomNav / Sheet / MobileGameScreen / MobileHub.
- `design_handoff_dnd_ai_master/prototype/app/pane-character.jsx` and `pane-mechanics.jsx` — show how `compact` prop branches the layout.
- `vaul` library: https://vaul.emilkowal.ski/
