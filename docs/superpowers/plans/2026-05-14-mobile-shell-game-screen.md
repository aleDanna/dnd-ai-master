# Mobile Shell + Game Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/sessions/[id]` usable on a 393×852 mobile viewport: single-pane chat with mini character bar, mechanics FAB, and `vaul`-powered drawers for the full character/mechanics views. Build the mobile shell foundation (hook, drawer primitive, top bar, bottom nav, icons) so phase 2 (hub mobile) only needs to wire screens, not chrome.

**Architecture:** A `useIsMobile()` hook (`matchMedia('(max-width: 720px)')`) branches inside `(authed)/layout.tsx` and `game-client.tsx`. No parallel `/mobile/*` routes; existing panes (`NarrativePane`, `CharacterPane`, `MechanicsPane`) accept a `compact` prop that turns off sticky/border chrome so they can live inside drawers. The drawer primitive is a thin wrapper around `vaul`.

**Tech Stack:** Next.js 16 App Router, React 19, `vaul` for drawer, `vitest` + `@testing-library/react` + `jsdom` for component tests.

**Spec reference:** [docs/superpowers/specs/2026-05-14-mobile-shell-game-screen-design.md](../specs/2026-05-14-mobile-shell-game-screen-design.md)

---

## Conventions used in this plan

- Test command: `pnpm test <path>` (vitest run, project auto-detected by path)
- Typecheck: `pnpm typecheck`
- Test directory mirrors source: component tests live in `tests/components/<area>/<name>.test.tsx`, library tests in `tests/lib/`.
- Commit style follows the existing repo (Conventional Commits-ish, no scope in subject for small refactors). The Anthropic Co-Authored-By footer is added automatically by the executor; do not include it manually here.

---

## Task 1: Install vaul and verify React 19 compatibility

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install vaul as a dependency**

Run:
```bash
pnpm add vaul
```

- [ ] **Step 2: Verify the resolved version supports React 19**

Run:
```bash
pnpm why vaul
```

Expected: a single resolved version under `vaul` with `react` peer dep satisfied by React 19. If pnpm reports a peer-dep warning that vaul requires React 18, re-run with `pnpm add vaul@latest` and check the GitHub release notes; if no React 19-compatible version exists, fall back to `pnpm add vaul --legacy-peer-deps` and document the override in this plan.

- [ ] **Step 3: Sanity-check the build still compiles**

Run:
```bash
pnpm typecheck
```

Expected: PASS with no new errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add vaul for mobile drawer primitive"
```

---

## Task 2: Extend `Icon` component with mobile glyphs

**Files:**
- Modify: `src/components/ui/icon.tsx`
- Test: `tests/components/ui/icon.test.tsx` (new)

The handoff README requires these new icon names: `image`, `menu`, `copy`, `chevron-down`, `chevron-up`, `globe`, `compass`, `flame`, `star`, `eye`. The existing `icon.tsx` uses inline SVG paths with `viewBox="0 0 24 24"` and stroke 1.5.

- [ ] **Step 1: Write the failing test**

Create `tests/components/ui/icon.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon, type IconName } from '@/components/ui/icon';

const NEW_NAMES: IconName[] = [
  'image', 'menu', 'copy', 'chevron-down', 'chevron-up',
  'globe', 'compass', 'flame', 'star', 'eye',
];

describe('Icon — mobile additions', () => {
  for (const name of NEW_NAMES) {
    it(`renders an <svg> for ${name}`, () => {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    });
  }

  it('respects the size prop', () => {
    const { container } = render(<Icon name="star" size={24} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/ui/icon.test.tsx
```

Expected: FAIL with TypeScript errors complaining that `image`, `menu`, etc. are not valid `IconName` values, OR runtime errors that the switch falls through without rendering.

- [ ] **Step 3: Extend `IconName` and add the SVG cases**

Edit `src/components/ui/icon.tsx`. Change the `IconName` union:

```ts
export type IconName =
  | 'dice' | 'heart' | 'shield' | 'sword' | 'spell' | 'book' | 'chat' | 'send'
  | 'plus' | 'arrow-right' | 'arrow-left' | 'settings' | 'sparkle' | 'check'
  | 'x' | 'user' | 'more' | 'logo-d20'
  | 'volume' | 'pause'
  | 'image' | 'menu' | 'copy' | 'chevron-down' | 'chevron-up'
  | 'globe' | 'compass' | 'flame' | 'star' | 'eye';
```

Then add these `case` branches before the closing `}` of the `switch (name)` block (paths adapted from Lucide, MIT-licensed):

```tsx
    case 'image':
      return (
        <svg {...baseProps}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
        </svg>
      );
    case 'menu':
      return <svg {...baseProps}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
    case 'copy':
      return (
        <svg {...baseProps}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case 'chevron-down':
      return <svg {...baseProps}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'chevron-up':
      return <svg {...baseProps}><polyline points="18 15 12 9 6 15" /></svg>;
    case 'globe':
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case 'compass':
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      );
    case 'flame':
      return (
        <svg {...baseProps}>
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        </svg>
      );
    case 'star':
      return (
        <svg {...baseProps}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...baseProps}>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/ui/icon.test.tsx
```

Expected: PASS, all 11 tests green.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/icon.tsx tests/components/ui/icon.test.tsx
git commit -m "feat(ui): add mobile icon glyphs (image, menu, copy, chevron, globe, compass, flame, star, eye)"
```

---

## Task 3: Implement `useIsMobile()` hook

**Files:**
- Create: `src/lib/use-is-mobile.ts`
- Test: `tests/lib/use-is-mobile.test.ts` (new — uses jsdom, so it must live under `tests/components/` per the vitest config, OR we add a `tests/lib-dom/` project. Easiest: put it in `tests/components/lib/use-is-mobile.test.tsx` so the jsdom project picks it up.)

Read `vitest.config.ts`: the **components** project (jsdom) matches `tests/components/**/*.test.{ts,tsx}`. The **node** project matches `tests/**/*.test.{ts,tsx}` except `tests/components/**`. Since this hook needs `window.matchMedia`, put the test under `tests/components/lib/`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/lib/use-is-mobile.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from '@/lib/use-is-mobile';

type Listener = (e: MediaQueryListEvent) => void;

function installMatchMedia(initial: boolean) {
  const listeners: Listener[] = [];
  const mql = {
    matches: initial,
    media: '(max-width: 720px)',
    onchange: null,
    addEventListener: (_: 'change', fn: Listener) => { listeners.push(fn); },
    removeEventListener: (_: 'change', fn: Listener) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => true,
    addListener: () => {},
    removeListener: () => {},
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    fire(next: boolean) {
      mql.matches = next;
      for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
    },
  };
}

describe('useIsMobile', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the initial matchMedia value on mount', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('returns false when the viewport is wider than the breakpoint', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('updates when the media query changes', () => {
    const mql = installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    act(() => { mql.fire(true); });
    expect(result.current).toBe(true);
  });

  it('uses a custom query when provided', () => {
    installMatchMedia(true);
    renderHook(() => useIsMobile('(max-width: 480px)'));
    expect((window.matchMedia as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('(max-width: 480px)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/lib/use-is-mobile.test.tsx
```

Expected: FAIL with "Cannot find module '@/lib/use-is-mobile'".

- [ ] **Step 3: Implement the hook**

Create `src/lib/use-is-mobile.ts`:

```ts
'use client';
import * as React from 'react';

const DEFAULT_QUERY = '(max-width: 720px)';

export function useIsMobile(query: string = DEFAULT_QUERY): boolean {
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const update = (): void => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return isMobile;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/lib/use-is-mobile.test.tsx
```

Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/use-is-mobile.ts tests/components/lib/use-is-mobile.test.tsx
git commit -m "feat(lib): add useIsMobile() hook backed by matchMedia"
```

---

## Task 4: Drawer wrapper around `vaul`

**Files:**
- Create: `src/components/ui/drawer.tsx`

No automated test for this one — it's a thin styling wrapper around a third-party primitive. Visual verification happens in Task 12 when we wire it into the game screen.

- [ ] **Step 1: Implement the wrapper**

Create `src/components/ui/drawer.tsx`:

```tsx
'use client';
import * as React from 'react';
import { Drawer as Vaul } from 'vaul';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** When true the drawer opens at ~60% height instead of the default 88%. */
  peek?: boolean;
}

export function Drawer({ open, onOpenChange, children, peek = false }: DrawerProps) {
  return (
    <Vaul.Root open={open} onOpenChange={onOpenChange}>
      <Vaul.Portal>
        <Vaul.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
            zIndex: 50,
          }}
        />
        <Vaul.Content
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 51,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: peek ? '60%' : '88%',
            background: 'var(--bg-elev)',
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderTop: '1px solid var(--border-strong)',
            outline: 'none',
          }}
        >
          <Vaul.Title style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
            Drawer
          </Vaul.Title>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, flexShrink: 0 }}>
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: 'var(--fg-subtle)',
                opacity: 0.4,
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{children}</div>
        </Vaul.Content>
      </Vaul.Portal>
    </Vaul.Root>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. If `vaul` types complain (e.g. missing `Title`), check the installed version and adjust import names — vaul v1.x exposes `Drawer.Root/Trigger/Portal/Overlay/Content/Title/Description`. If you can't find `Title`, render an `aria-label` on `Vaul.Content` instead.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/drawer.tsx
git commit -m "feat(ui): add Drawer wrapper around vaul"
```

---

## Task 5: `TopBarMobile` component

**Files:**
- Create: `src/components/layout/top-bar-mobile.tsx`
- Test: `tests/components/layout/top-bar-mobile.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/components/layout/top-bar-mobile.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopBarMobile } from '@/components/layout/top-bar-mobile';

describe('TopBarMobile', () => {
  it('renders the title', () => {
    render(<TopBarMobile title="The Mill at Hollowcreek" />);
    expect(screen.getByText('The Mill at Hollowcreek')).toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    render(<TopBarMobile title="Hub" subtitle="AI&Games" />);
    expect(screen.getByText('AI&Games')).toBeInTheDocument();
  });

  it('renders leading and trailing slots', () => {
    render(
      <TopBarMobile
        title="Title"
        leading={<button>Back</button>}
        trailing={<button>Menu</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/layout/top-bar-mobile.test.tsx
```

Expected: FAIL with "Cannot find module '@/components/layout/top-bar-mobile'".

- [ ] **Step 3: Implement the component**

Create `src/components/layout/top-bar-mobile.tsx`:

```tsx
'use client';
import * as React from 'react';

export interface TopBarMobileProps {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

export function TopBarMobile({ title, subtitle, leading, trailing }: TopBarMobileProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        background: 'var(--bg-elev)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        zIndex: 20,
        minHeight: 44,
      }}
    >
      <div style={{ width: 60, display: 'flex', justifyContent: 'flex-start' }}>{leading}</div>
      <div style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 600,
            lineHeight: 1.1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-subtle)',
              fontFamily: 'var(--font-mono)',
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      <div style={{ width: 60, display: 'flex', justifyContent: 'flex-end', gap: 4 }}>{trailing}</div>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/layout/top-bar-mobile.test.tsx
```

Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/top-bar-mobile.tsx tests/components/layout/top-bar-mobile.test.tsx
git commit -m "feat(layout): add TopBarMobile component"
```

---

## Task 6: `BottomNav` component

**Files:**
- Create: `src/components/layout/bottom-nav.tsx`
- Test: `tests/components/layout/bottom-nav.test.tsx`

The bottom nav has 3 tabs that map to `/campaigns`, `/hub`, `/settings`. The active tab is derived from `usePathname()`. Tap navigates via `<Link>`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/layout/bottom-nav.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BottomNav } from '@/components/layout/bottom-nav';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

import { usePathname } from 'next/navigation';

describe('BottomNav', () => {
  it('renders the three tab labels', () => {
    vi.mocked(usePathname).mockReturnValue('/hub');
    render(<BottomNav />);
    expect(screen.getByText('Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Heroes')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('marks /hub as the active tab when pathname is /hub', () => {
    vi.mocked(usePathname).mockReturnValue('/hub');
    render(<BottomNav />);
    const heroes = screen.getByRole('link', { name: /Heroes/ });
    expect(heroes).toHaveAttribute('aria-current', 'page');
    const campaigns = screen.getByRole('link', { name: /Campaigns/ });
    expect(campaigns).not.toHaveAttribute('aria-current');
  });

  it('marks /campaigns as the active tab when pathname is /campaigns', () => {
    vi.mocked(usePathname).mockReturnValue('/campaigns');
    render(<BottomNav />);
    expect(screen.getByRole('link', { name: /Campaigns/ })).toHaveAttribute('aria-current', 'page');
  });

  it('marks /settings as the active tab when pathname is /settings', () => {
    vi.mocked(usePathname).mockReturnValue('/settings');
    render(<BottomNav />);
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark any tab active on unrelated paths', () => {
    vi.mocked(usePathname).mockReturnValue('/campaigns/abc-123');
    render(<BottomNav />);
    for (const label of ['Campaigns', 'Heroes', 'Settings']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).not.toHaveAttribute('aria-current');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/layout/bottom-nav.test.tsx
```

Expected: FAIL with "Cannot find module '@/components/layout/bottom-nav'".

- [ ] **Step 3: Implement the component**

Create `src/components/layout/bottom-nav.tsx`:

```tsx
'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/icon';

interface Tab {
  key: 'campaigns' | 'heroes' | 'settings';
  href: string;
  label: string;
  icon: IconName;
}

const TABS: Tab[] = [
  { key: 'campaigns', href: '/campaigns', label: 'Campaigns', icon: 'book' },
  { key: 'heroes', href: '/hub', label: 'Heroes', icon: 'user' },
  { key: 'settings', href: '/settings', label: 'Settings', icon: 'settings' },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      style={{
        display: 'flex',
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        zIndex: 15,
      }}
    >
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            style={{
              flex: 1,
              padding: '10px 0 8px',
              textDecoration: 'none',
              color: active ? 'var(--arcane-2)' : 'var(--fg-subtle)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              fontFamily: 'var(--font-ui)',
            }}
          >
            <Icon name={t.icon} size={20} />
            <span style={{ fontSize: 10, fontWeight: 500 }}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/layout/bottom-nav.test.tsx
```

Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/bottom-nav.tsx tests/components/layout/bottom-nav.test.tsx
git commit -m "feat(layout): add BottomNav with pathname-driven active state"
```

---

## Task 7: Rewrite `(authed)/layout.tsx` as a responsive client layout

**Files:**
- Modify: `src/app/(authed)/layout.tsx`
- Test: `tests/components/layout/authed-layout.test.tsx` (new)

The layout currently is a server component that renders `<TopBar />` for every authed route. We need it to:
1. Become a client component (so it can call `useIsMobile()` and `usePathname()`).
2. Skip the chrome top bar entirely on `/sessions/[id]` (the page renders its own header).
3. On mobile + hub routes (`/hub`, `/campaigns`, `/settings`) render `<BottomNav />` and add `paddingBottom: 72` to the content wrapper.
4. On mobile + non-session non-hub routes, render a generic `<TopBarMobile />` (logo + page label).
5. On desktop everywhere except sessions, render `<TopBar />` as today.

- [ ] **Step 1: Write the failing test**

Create `tests/components/layout/authed-layout.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AuthedLayout from '@/app/(authed)/layout';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));
vi.mock('@/lib/use-is-mobile', () => ({
  useIsMobile: vi.fn(),
}));

import { usePathname } from 'next/navigation';
import { useIsMobile } from '@/lib/use-is-mobile';

function setup(pathname: string, mobile: boolean) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useIsMobile).mockReturnValue(mobile);
}

describe('(authed)/layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the desktop top bar on /hub at desktop width', () => {
    setup('/hub', false);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    // Desktop TopBar contains the nav links "Campaigns" and "Characters"
    expect(screen.getByRole('link', { name: 'Characters' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeTruthy();
    // No bottom nav on desktop
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
  });

  it('renders the mobile top bar + bottom nav on /hub at mobile width', () => {
    setup('/hub', true);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    // Desktop TopBar nav links absent (it should not render at all)
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull();
    // Bottom nav present
    expect(screen.getByRole('link', { name: /Heroes/ })).toBeInTheDocument();
  });

  it('does NOT render bottom nav on /campaigns/[id] at mobile width', () => {
    setup('/campaigns/abc-123', true);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
  });

  it('does NOT render any chrome top bar on /sessions/[id]', () => {
    setup('/sessions/abc-123', true);
    render(<AuthedLayout><div data-testid="page">page</div></AuthedLayout>);
    // Layout chrome absent — game-client has its own
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('does NOT render bottom nav on /campaigns/new at mobile width', () => {
    setup('/campaigns/new', true);
    render(<AuthedLayout><div>page</div></AuthedLayout>);
    expect(screen.queryByRole('link', { name: /Heroes/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/layout/authed-layout.test.tsx
```

Expected: FAIL — current layout always renders `<TopBar/>` so most assertions about its absence fail.

- [ ] **Step 3: Rewrite the layout**

Replace the contents of `src/app/(authed)/layout.tsx`:

```tsx
'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { TopBar } from '@/components/layout/top-bar';
import { TopBarMobile } from '@/components/layout/top-bar-mobile';
import { BottomNav } from '@/components/layout/bottom-nav';
import { Icon } from '@/components/ui/icon';
import { useIsMobile } from '@/lib/use-is-mobile';

const HUB_ROUTES = new Set(['/hub', '/campaigns', '/settings']);

function isSessionPage(pathname: string): boolean {
  return pathname.startsWith('/sessions/');
}

function isHubRoute(pathname: string): boolean {
  return HUB_ROUTES.has(pathname);
}

function pageLabelFor(pathname: string): string {
  if (pathname.startsWith('/campaigns/new')) return 'New campaign';
  if (pathname.startsWith('/characters/new')) return 'New character';
  if (pathname.startsWith('/campaigns/')) return 'Campaign';
  if (pathname.startsWith('/characters/')) return 'Character';
  if (pathname.startsWith('/r/')) return 'Invite';
  if (pathname === '/hub') return 'Heroes';
  if (pathname === '/campaigns') return 'Campaigns';
  if (pathname === '/settings') return 'Settings';
  return 'AI&Games';
}

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const isMobile = useIsMobile();

  if (isSessionPage(pathname)) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>{children}</div>;
  }

  const showBottomNav = isMobile && isHubRoute(pathname);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {isMobile ? (
        <TopBarMobile
          leading={<Icon name="logo-d20" size={20} />}
          title={pageLabelFor(pathname)}
          subtitle="AI&Games"
        />
      ) : (
        <TopBar />
      )}
      <div style={{ paddingBottom: showBottomNav ? 72 : 0 }}>{children}</div>
      {showBottomNav ? <BottomNav /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/layout/authed-layout.test.tsx
```

Expected: PASS, all 5 tests green.

- [ ] **Step 5: Run the full component test suite to verify nothing regressed**

```bash
pnpm test tests/components
```

Expected: PASS. The existing layout had no test coverage so existing component tests should be unaffected.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/(authed)/layout.tsx tests/components/layout/authed-layout.test.tsx
git commit -m "feat(layout): responsive authed layout with mobile top bar + bottom nav"
```

---

## Task 8: Add `compact` prop to `CharacterPane`

**Files:**
- Modify: `src/components/game/character-pane.tsx`
- Test: `tests/components/game/character-pane.test.tsx` (existing — add cases)

The compact mode strips desktop sidebar chrome (`width: 280`, `borderRight`, sticky positioning) so the pane can live inside a drawer.

- [ ] **Step 1: Read the existing test file to understand patterns**

```bash
cat tests/components/game/character-pane.test.tsx | head -80
```

This is reference reading only — note the imports and `baseState()` helper, if any.

- [ ] **Step 2: Add the failing test cases**

Append to `tests/components/game/character-pane.test.tsx` (inside the same `describe` block or a new one — adapt to the file's structure):

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CharacterPane } from '@/components/game/character-pane';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

function minimalCharacter(): Character {
  return {
    id: 'ch-1',
    name: 'Tharion',
    raceSlug: 'half-elf',
    classSlug: 'fighter',
    level: 3,
    xp: 900,
    hpMax: 27,
    ac: 16,
    speed: 30,
    proficiencyBonus: 2,
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [],
    features: [],
    classes: [{ slug: 'fighter', level: 3 }],
  } as unknown as Character;
}

function minimalState(): SessionStateRow {
  return {
    sessionId: 's-1', hpCurrent: 21, tempHp: 0, hitDiceRemaining: 3,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null, scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
  } as unknown as SessionStateRow;
}

describe('CharacterPane compact prop', () => {
  it('renders without the sticky desktop sidebar chrome when compact=true', () => {
    const { container } = render(
      <CharacterPane character={minimalCharacter()} state={minimalState()} compact />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.style.position).not.toBe('sticky');
    expect(aside.style.width).not.toBe('280px');
    expect(aside.style.borderRight).toBe('');
  });

  it('renders with the sticky sidebar chrome when compact is false (default)', () => {
    const { container } = render(
      <CharacterPane character={minimalCharacter()} state={minimalState()} />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.style.position).toBe('sticky');
    expect(aside.style.width).toBe('280px');
  });
});
```

If the file's existing tests already create a character/state helper, reuse those instead of defining new ones (DRY).

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm test tests/components/game/character-pane.test.tsx
```

Expected: FAIL — `compact` prop doesn't exist; the runtime warning will be a TypeScript error from `pnpm typecheck`, or the assertions on style will fail.

- [ ] **Step 4: Add the `compact` prop**

Edit `src/components/game/character-pane.tsx`:

1. Extend the props interface:
```ts
export interface CharacterPaneProps {
  character: Character;
  state: SessionStateRow;
  enrichedInventory?: MasterInventoryView[];
  /** When true the pane drops desktop sidebar chrome and renders as drawer content. */
  compact?: boolean;
}
```

2. Destructure `compact = false` and conditionally apply the chrome styles:
```tsx
export function CharacterPane({ character, state, enrichedInventory, compact = false }: CharacterPaneProps) {
  // ...existing hpPct/hpTone derivation
  return (
    <aside
      style={{
        width: compact ? '100%' : 280,
        padding: 18,
        borderRight: compact ? 'none' : '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        flexShrink: 0,
        ...(compact
          ? {}
          : {
              position: 'sticky',
              top: 56,
              height: 'calc(100vh - 56px)',
              overflowY: 'auto',
            }),
      }}
    >
      {/* ...existing children unchanged */}
    </aside>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test tests/components/game/character-pane.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/game/character-pane.tsx tests/components/game/character-pane.test.tsx
git commit -m "feat(game): add compact prop to CharacterPane for drawer use"
```

---

## Task 9: Add `compact` prop to `MechanicsPane`

**Files:**
- Modify: `src/components/game/mechanics-pane.tsx`
- Test: `tests/components/mechanics-pane.test.tsx` (existing — add cases)

- [ ] **Step 1: Add the failing test cases**

Append to `tests/components/mechanics-pane.test.tsx`:

```tsx
describe('MechanicsPane compact prop', () => {
  it('renders without the sticky desktop sidebar chrome when compact=true', () => {
    const { container } = render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState()}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
        compact
      />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.style.position).not.toBe('sticky');
    expect(aside.style.width).not.toBe('320px');
    expect(aside.style.borderLeft).toBe('');
  });

  it('renders with the sticky sidebar chrome by default', () => {
    const { container } = render(
      <MechanicsPane
        sessionId="sess-1"
        state={baseState()}
        actors={[]}
        pcCharacterId="pc1" pcName="Tharion" pcHpMax={10} pcLevel={1} pcXp={0}
      />,
    );
    const aside = container.querySelector('aside')!;
    expect(aside.style.position).toBe('sticky');
    expect(aside.style.width).toBe('320px');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/mechanics-pane.test.tsx
```

Expected: FAIL — `compact` doesn't exist.

- [ ] **Step 3: Add the `compact` prop**

Edit `src/components/game/mechanics-pane.tsx`:

1. Extend the props interface:
```ts
export interface MechanicsPaneProps {
  sessionId: string;
  state: SessionStateRow;
  actors: CombatActorRow[];
  pcCharacterId: string;
  pcName: string;
  pcHpMax: number;
  pcLevel: number;
  pcXp: number;
  pcSpeed?: number;
  onEndCombat?: () => void;
  /** When true the pane drops desktop sidebar chrome and renders as drawer content. */
  compact?: boolean;
}
```

2. Destructure `compact = false`, conditionally apply the chrome styles:
```tsx
export function MechanicsPane({ sessionId, state, actors, pcCharacterId, pcName, pcHpMax, pcLevel, pcXp, pcSpeed, onEndCombat, compact = false }: MechanicsPaneProps) {
  const travel = state.travel;
  const showTravel = travel != null && (travel.pace || travel.lightLevel);
  return (
    <aside
      style={{
        width: compact ? '100%' : 320,
        padding: 18,
        borderLeft: compact ? 'none' : '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        flexShrink: 0,
        ...(compact
          ? {}
          : {
              position: 'sticky',
              top: 56,
              height: 'calc(100vh - 56px)',
              overflowY: 'auto',
            }),
      }}
    >
      {/* ...existing children unchanged */}
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/mechanics-pane.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/game/mechanics-pane.tsx tests/components/mechanics-pane.test.tsx
git commit -m "feat(game): add compact prop to MechanicsPane for drawer use"
```

---

## Task 10: Add `compact` prop to `NarrativePane`

**Files:**
- Modify: `src/components/game/narrative-pane.tsx`
- Test: `tests/components/game/narrative-pane-compact.test.tsx` (new)

Compact mode tightens padding and **hides the quick-action bar** (Skill check / Attack / Dodge / Rest / Rule), per the design.

- [ ] **Step 1: Write the failing test**

Create `tests/components/game/narrative-pane-compact.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NarrativePane } from '@/components/game/narrative-pane';

describe('NarrativePane compact prop', () => {
  it('hides the quick-action bar when compact=true', () => {
    render(
      <NarrativePane
        sessionId="sess-1"
        history={[]}
        liveEvents={[]}
        busy={false}
        onSend={() => {}}
        manualRolls={false}
        compact
      />,
    );
    expect(screen.queryByRole('button', { name: /Skill check/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Attack$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dodge/i })).toBeNull();
  });

  it('shows the quick-action bar when compact is false (default)', () => {
    render(
      <NarrativePane
        sessionId="sess-1"
        history={[]}
        liveEvents={[]}
        busy={false}
        onSend={() => {}}
        manualRolls={false}
      />,
    );
    expect(screen.getByRole('button', { name: /Skill check/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/game/narrative-pane-compact.test.tsx
```

Expected: FAIL on the first test — quick-action buttons still render because `compact` doesn't exist yet.

- [ ] **Step 3: Add the `compact` prop**

Edit `src/components/game/narrative-pane.tsx`:

1. Add to `NarrativePaneProps`:
```ts
/** When true, padding tightens and the quick-action bar is hidden (mobile drawer host). */
compact?: boolean;
```

2. Destructure with a default in the function signature:
```ts
export function NarrativePane({
  sessionId, history, liveEvents, busy, onSend, onCastSpell,
  manualRolls, imageGenerationEnabled = false, disabled = false,
  disabledPlaceholder, party = [], compact = false,
}: NarrativePaneProps) {
```

3. Apply compact-aware padding to the message area and composer container. Replace the existing message-area `<div style={{ flex: 1, padding: '32px 40px 80px' }}>` with:
```tsx
<div style={{ flex: 1, padding: compact ? '16px 20px 100px' : '32px 40px 80px' }}>
```

4. Replace the composer's outer wrapper `<div style={{ position: 'sticky', bottom: 0, ... }}>`'s child padding wrappers:
   - Quick-action wrapper `<div style={{ padding: '10px 40px 0' }}>` → wrap it in `{!compact && (...)}`.
   - Composer wrapper `<div style={{ padding: '8px 40px 20px' }}>` → use `compact ? '8px 16px 16px' : '8px 40px 20px'`.

The full block becomes:
```tsx
<div style={{ position: 'sticky', bottom: 0, background: 'var(--bg-elev)', borderTop: '1px solid var(--border)', zIndex: 5 }}>
  {!compact && (
    <div style={{ padding: '10px 40px 0' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', gap: 6, paddingTop: 8, paddingBottom: 4, flexWrap: 'wrap' }}>
        <Quick icon="dice" label="Skill check" disabled={disabled} onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I make a Perception check.')} />
        <Quick icon="sword" label="Attack" disabled={disabled} onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I attack with my equipped weapon.')} />
        {onCastSpell && <Quick icon="spell" label="Cast spell" disabled={disabled} onClick={onCastSpell} />}
        <Quick icon="shield" label="Dodge" disabled={disabled} onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'I take the Dodge action.')} />
        <Quick icon="heart" label="Short rest" disabled={disabled} onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'We take a short rest.')} />
        <div style={{ flex: 1 }} />
        <Quick icon="book" label="Look up rule" disabled={disabled} onClick={() => setDraft((d) => d + (d ? ' ' : '') + 'Master, look up the rule for ')} />
      </div>
    </div>
  )}
  <div style={{ padding: compact ? '8px 16px 16px' : '8px 40px 20px' }}>
    {/* existing composer body unchanged */}
  </div>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/game/narrative-pane-compact.test.tsx
```

Expected: PASS, both tests green.

- [ ] **Step 5: Run all NarrativePane tests to verify no regression**

```bash
pnpm test tests/components/game/narrative-pane-
```

Expected: PASS on all existing narrative-pane tests (disabled, pagination, roll-flow) plus the new compact test.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/game/narrative-pane.tsx tests/components/game/narrative-pane-compact.test.tsx
git commit -m "feat(game): add compact prop to NarrativePane (tight padding, hide quick actions)"
```

---

## Task 11: `MobileCharacterBar` component

**Files:**
- Create: `src/components/game/mobile-character-bar.tsx`
- Test: `tests/components/game/mobile-character-bar.test.tsx`

Sticky 56px bar shown under the top bar on the mobile game screen. Tapping opens the character drawer.

- [ ] **Step 1: Write the failing test**

Create `tests/components/game/mobile-character-bar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileCharacterBar } from '@/components/game/mobile-character-bar';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

function character(over: Partial<Character> = {}): Character {
  return {
    id: 'ch-1', name: 'Tharion', raceSlug: 'half-elf', classSlug: 'fighter',
    level: 3, xp: 900, hpMax: 27, ac: 16, speed: 30, proficiencyBonus: 2,
    abilities: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 12 },
    inventory: [], features: [],
    ...over,
  } as unknown as Character;
}

function state(over: Partial<SessionStateRow> = {}): SessionStateRow {
  return {
    sessionId: 's-1', hpCurrent: 21, tempHp: 0, hitDiceRemaining: 3,
    spellSlotsUsed: {}, conditions: [], resourcesUsed: {},
    inCombat: false, combat: null, scene: '', sceneImageVersion: 0, sceneImagePrompt: null,
    ...over,
  } as unknown as SessionStateRow;
}

describe('MobileCharacterBar', () => {
  it('shows the character name and L/AC stats', () => {
    render(<MobileCharacterBar character={character()} state={state()} onOpen={() => {}} />);
    expect(screen.getByText('Tharion')).toBeInTheDocument();
    expect(screen.getByText(/L3 · AC 16/)).toBeInTheDocument();
  });

  it('shows the HP fraction', () => {
    render(<MobileCharacterBar character={character()} state={state({ hpCurrent: 21 })} onOpen={() => {}} />);
    expect(screen.getByText('21/27 HP')).toBeInTheDocument();
  });

  it('fires onOpen when tapped', () => {
    const onOpen = vi.fn();
    render(<MobileCharacterBar character={character()} state={state()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the inspiration star when character.inspiration is true', () => {
    render(
      <MobileCharacterBar
        character={character({ inspiration: true } as Partial<Character>)}
        state={state()}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByLabelText(/inspiration/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/game/mobile-character-bar.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/game/mobile-character-bar.tsx`:

```tsx
'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';

export interface MobileCharacterBarProps {
  character: Character;
  state: SessionStateRow;
  onOpen: () => void;
}

export function MobileCharacterBar({ character, state, onOpen }: MobileCharacterBarProps) {
  const hpPct = character.hpMax > 0 ? Math.round((state.hpCurrent / character.hpMax) * 100) : 0;
  const hpTone = hpPct <= 25 ? 'var(--ember)' : hpPct <= 50 ? 'var(--gold)' : 'var(--verdigris)';
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        background: 'var(--bg-elev)',
        borderBottom: '1px solid var(--border)',
        border: 0,
        borderRadius: 0,
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        fontFamily: 'inherit',
        flexShrink: 0,
        position: 'sticky',
        top: 44,
        zIndex: 19,
        width: '100%',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 6,
          background: 'var(--bone)',
          color: 'var(--ink)',
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {character.name[0]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{character.name}</span>
          {character.inspiration ? (
            <Icon name="star" size={12} aria-label="Inspiration" style={{ color: 'var(--gold)' }} />
          ) : null}
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
            L{character.level} · AC {character.ac}
          </span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>
            {state.hpCurrent}/{character.hpMax} HP
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-sunken)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, hpPct))}%`, background: hpTone }} />
        </div>
      </div>
      <Icon name="chevron-up" size={14} style={{ color: 'var(--fg-subtle)' }} />
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/game/mobile-character-bar.test.tsx
```

Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/game/mobile-character-bar.tsx tests/components/game/mobile-character-bar.test.tsx
git commit -m "feat(game): add MobileCharacterBar sticky mini-stats bar"
```

---

## Task 12: `MobileMechanicsFab` component

**Files:**
- Create: `src/components/game/mobile-mechanics-fab.tsx`
- Test: `tests/components/game/mobile-mechanics-fab.test.tsx`

Floating action button, 48×48, bottom-right above composer. Icon depends on game mode; round-number badge when in combat.

- [ ] **Step 1: Write the failing test**

Create `tests/components/game/mobile-mechanics-fab.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileMechanicsFab } from '@/components/game/mobile-mechanics-fab';

describe('MobileMechanicsFab', () => {
  it('renders a button with aria-label "Mechanics"', () => {
    render(<MobileMechanicsFab gameMode="exploration" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mechanics' })).toBeInTheDocument();
  });

  it('fires onOpen on click', () => {
    const onOpen = vi.fn();
    render(<MobileMechanicsFab gameMode="exploration" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the round badge in combat mode with a round number', () => {
    render(<MobileMechanicsFab gameMode="combat" round={3} onOpen={() => {}} />);
    expect(screen.getByText('R3')).toBeInTheDocument();
  });

  it('does not show a badge when round is not provided even in combat', () => {
    render(<MobileMechanicsFab gameMode="combat" onOpen={() => {}} />);
    expect(screen.queryByText(/^R\d+$/)).toBeNull();
  });

  it('does not show a badge in exploration mode', () => {
    render(<MobileMechanicsFab gameMode="exploration" round={2} onOpen={() => {}} />);
    expect(screen.queryByText(/^R\d+$/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test tests/components/game/mobile-mechanics-fab.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/game/mobile-mechanics-fab.tsx`:

```tsx
'use client';
import * as React from 'react';
import { Icon } from '@/components/ui/icon';

export type GameMode = 'combat' | 'exploration';

export interface MobileMechanicsFabProps {
  gameMode: GameMode;
  round?: number;
  onOpen: () => void;
}

export function MobileMechanicsFab({ gameMode, round, onOpen }: MobileMechanicsFabProps) {
  const inCombat = gameMode === 'combat';
  const showBadge = inCombat && typeof round === 'number' && round > 0;
  return (
    <button
      type="button"
      aria-label="Mechanics"
      onClick={onOpen}
      style={{
        position: 'fixed',
        bottom: 86,
        right: 14,
        zIndex: 6,
        width: 48,
        height: 48,
        borderRadius: '50%',
        background: inCombat ? 'var(--ember)' : 'var(--bg-card)',
        border: '1px solid ' + (inCombat ? 'var(--ember-2)' : 'var(--border-strong)'),
        color: inCombat ? '#fff' : 'var(--fg-muted)',
        boxShadow: 'var(--shadow-3)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={inCombat ? 'sword' : 'compass'} size={20} />
      {showBadge ? (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            background: 'var(--gold)',
            color: 'var(--ink)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 999,
            border: '2px solid var(--bg)',
          }}
        >
          R{round}
        </span>
      ) : null}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test tests/components/game/mobile-mechanics-fab.test.tsx
```

Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/game/mobile-mechanics-fab.tsx tests/components/game/mobile-mechanics-fab.test.tsx
git commit -m "feat(game): add MobileMechanicsFab floating button with combat round badge"
```

---

## Task 13: Wire the mobile branch into `game-client.tsx`

**Files:**
- Modify: `src/app/(authed)/sessions/[id]/game-client.tsx`
- Test: manual verification (the wiring is too entangled with SSE state for a meaningful component test; the individual pieces are already tested)

- [ ] **Step 1: Add imports for the new mobile pieces**

At the top of `src/app/(authed)/sessions/[id]/game-client.tsx`, add:

```ts
import { useIsMobile } from '@/lib/use-is-mobile';
import { TopBarMobile } from '@/components/layout/top-bar-mobile';
import { Drawer } from '@/components/ui/drawer';
import { MobileCharacterBar } from '@/components/game/mobile-character-bar';
import { MobileMechanicsFab } from '@/components/game/mobile-mechanics-fab';
```

- [ ] **Step 2: Add mobile state hooks inside `GameClient`**

After the existing `const [autoplay, setAutoplay] = React.useState(initialAutoplay);` declaration, add:

```tsx
const isMobile = useIsMobile();
const [charDrawerOpen, setCharDrawerOpen] = React.useState(false);
const [mechDrawerOpen, setMechDrawerOpen] = React.useState(false);
```

- [ ] **Step 3: Branch the rendered tree on mobile**

The existing function ends with `if (!liveState) { return <Loading…/> }` followed by `const slots = …; const composerDisabled = …;` and the desktop `return (...)`. Insert the mobile branch **between** the `composerDisabled` declaration and the desktop return — that way `liveState` is guaranteed non-null and all derived helpers are in scope.

The current return looks like:

```tsx
return (
  <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)', flexDirection: 'column' }}>
    <header style={{ ... }}>...</header>
    <div style={{ display: 'flex', flex: 1, alignItems: 'stretch' }}>
      <CharacterPane ... />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
        ...{!memoryReady ? <MemoryStatusBanner/> : ...}
        ...PartyStrip...
        <NarrativePane ... />
        ...sendError block...
        {spellOpen && ...}
      </div>
      <MechanicsPane ... />
    </div>
  </div>
);
```

Right before that `return`, insert the mobile branch. Replace the final `return (...)` with:

```tsx
if (isMobile) {
  const inCombat = liveState.inCombat;
  const round = (liveState.combat?.round as number | undefined) ?? undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      <TopBarMobile
        leading={
          <Link href="/sessions">
            <Button variant="ghost" size="sm" icon="arrow-left" aria-label="Back to sessions" />
          </Link>
        }
        title={campaign?.name ?? `${character.name}'s session`}
        subtitle={`${inCombat ? 'COMBAT' : 'EXPLORATION'} · ${(campaign?.language ?? session.language)?.toUpperCase() ?? '—'} · ${party.length > 1 ? `${party.length}P` : 'SOLO'}`}
        trailing={
          <>
            <AutoplayToggle value={autoplay} onChange={setAutoplay} />
            <SettingsLink variant="ghost" size="sm" iconOnly />
          </>
        }
      />
      <MobileCharacterBar character={character} state={liveState} onOpen={() => setCharDrawerOpen(true)} />
      {snapshot && party.length > 1 && (
        <div style={{ padding: '6px 12px', background: 'var(--bg)', position: 'sticky', top: 100, zIndex: 18, flexShrink: 0 }}>
          <PartyStrip
            party={party}
            currentPlayerCharacterId={currentPlayerCharacterId}
            viewerCharacterId={viewerCharacterId}
          />
        </div>
      )}
      {!memoryReady && (
        <div style={{ padding: '8px 16px', flexShrink: 0 }}>
          <MemoryStatusBanner sessionId={sessionId} onReady={handleMemoryReady} />
        </div>
      )}
      <NarrativePane
        sessionId={sessionId}
        history={messages}
        liveEvents={liveEvents}
        busy={busy}
        onSend={send}
        onCastSpell={!composerDisabled && character.spellcasting && slots.length > 0 ? () => setSpellOpen(true) : undefined}
        manualRolls={initialManualRolls}
        imageGenerationEnabled={initialImageGenerationEnabled}
        disabled={composerDisabled}
        disabledPlaceholder={!memoryReady ? 'Preparazione memoria in corso…' : `Waiting for ${currentPlayerName}…`}
        party={party}
        compact
      />
      <MobileMechanicsFab
        gameMode={inCombat ? 'combat' : 'exploration'}
        round={round}
        onOpen={() => setMechDrawerOpen(true)}
      />
      <Drawer open={charDrawerOpen} onOpenChange={setCharDrawerOpen}>
        <CharacterPane character={character} state={liveState} enrichedInventory={enrichedInventory} compact />
      </Drawer>
      <Drawer open={mechDrawerOpen} onOpenChange={setMechDrawerOpen}>
        <MechanicsPane
          sessionId={sessionId}
          state={liveState}
          actors={liveActors}
          pcCharacterId={character.id}
          pcLevel={character.level}
          pcXp={character.xp}
          onEndCombat={endCombat}
          pcName={character.name}
          pcHpMax={character.hpMax}
          pcSpeed={character.speed}
          compact
        />
      </Drawer>
      {(sendError || streamError || turnError) && (
        <div style={{ padding: '8px 16px', background: 'var(--bg-card)', color: 'var(--ember)', borderTop: '1px solid var(--ember)', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="x" size={12} />
            {sendError ?? streamError ?? turnError?.message ?? 'Errore turno.'}
          </span>
          {turnError && (
            <button type="button" onClick={clearTurnError} style={{ background: 'transparent', border: '1px solid var(--ember)', color: 'var(--ember)', padding: '2px 8px', borderRadius: 999, fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>
              Chiudi
            </button>
          )}
        </div>
      )}
      {spellOpen && character.spellcasting && !composerDisabled && (
        <SpellModal
          spellsKnown={character.spellcasting.spellsKnown}
          slots={slots}
          onCast={(spellSlug, slotLevel) => {
            send(`I cast ${spellSlug} at level ${slotLevel}.`);
            setSpellOpen(false);
          }}
          onClose={() => setSpellOpen(false)}
        />
      )}
    </div>
  );
}

// Desktop branch — unchanged
return (
  <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)', flexDirection: 'column' }}>
    {/* ...existing JSX exactly as before */}
  </div>
);
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS. If `liveState.combat?.round` is typed as `unknown` or differently, adjust the access; the actual shape is exposed via `combat-tracker.tsx` so a quick cross-check there will reveal the right path.

- [ ] **Step 5: Run all existing game-client related tests to catch regressions**

```bash
pnpm test tests/components/game tests/components/mechanics-pane.test.tsx tests/components/layout
```

Expected: PASS.

- [ ] **Step 6: Manual verification — desktop unchanged**

1. Run `pnpm dev`.
2. In Chrome, open `http://localhost:3000` at default desktop width (1280+).
3. Sign in, navigate to a session.
4. **Verify**: the 3-pane layout renders exactly as before (CharacterPane left, NarrativePane center, MechanicsPane right, quick-action bar visible, party strip in multiplayer).

- [ ] **Step 7: Manual verification — mobile game screen**

1. In Chrome DevTools, switch to device emulation → iPhone 16 Pro (393×852).
2. Reload the same session URL.
3. **Verify the mobile stack** top to bottom:
   - 44px sticky top bar: back button (left), campaign name + subtitle (center), autoplay + settings (right).
   - 56px sticky mini character bar: portrait, name, L/AC, HP fraction, HP bar, chevron-up.
   - (Multiplayer only) party strip with active-turn pill.
   - Chat surface with tighter padding; quick-action bar is **hidden**.
   - Composer at the bottom with tight padding.
   - Floating FAB bottom-right, just above the composer.
4. **Tap the mini character bar** → drawer slides up. Verify every section is visible: HP, AC stats, abilities, conditions, spell slots (if spellcaster), spells, currency, equipped, inventory, resources.
5. **Drag the handle down** → drawer dismisses.
6. **Tap the FAB** → mechanics drawer slides up with XP bar, travel (if set), combat tracker, dice log, scene + image.
7. **Resize back to desktop width** → 3-pane layout returns, drawers gone, no state lost.
8. **In combat**: FAB icon switches to `sword`, gold round badge appears (e.g. `R3`).
9. **In exploration**: FAB icon switches to `compass`, no badge.

- [ ] **Step 8: Manual verification — chrome routing**

1. Mobile width, navigate to `/hub` → bottom nav visible, "Heroes" tab active.
2. Navigate to `/campaigns` → "Campaigns" tab active.
3. Navigate to `/settings` → "Settings" tab active.
4. Navigate to `/campaigns/some-id` → bottom nav **hidden**.
5. Navigate to `/campaigns/new` → bottom nav hidden.
6. Navigate to `/sessions/some-id` → neither layout chrome top bar nor bottom nav rendered (game-client owns its top bar).
7. Desktop width on all of the above → never any bottom nav; desktop `TopBar` everywhere except sessions.

- [ ] **Step 9: Commit**

```bash
git add src/app/(authed)/sessions/[id]/game-client.tsx
git commit -m "feat(game): render single-pane mobile game screen with drawers on ≤720px"
```

---

## Task 14: Final regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

```bash
pnpm typecheck
```

Expected: PASS, no new errors.

- [ ] **Step 2: Full lint**

```bash
pnpm lint
```

Expected: PASS, no new errors. If new `'use client'` directives trip a rule, fix them inline.

- [ ] **Step 3: Full test suite**

```bash
pnpm test
```

Expected: PASS on every project (components + node). Investigate any failure before moving on; the changes here should not affect node tests but the auth layout, character/mechanics pane changes might surface latent assumptions in older tests.

- [ ] **Step 4: Build**

```bash
pnpm build
```

Expected: build completes. Vaul ships ESM-only — if there's a build error about CJS interop, check the `next.config.ts` for `transpilePackages` and add `vaul` if needed.

- [ ] **Step 5: One final manual smoke**

Spin up `pnpm dev`, open the app once at desktop and once at mobile, send a few messages in a session. Confirm no console errors in either layout.

---

## Self-review summary

**Spec coverage** (one task per spec requirement):

| Spec requirement | Task |
|---|---|
| Install vaul | 1 |
| useIsMobile() hook | 3 |
| Drawer primitive | 4 |
| Icon additions (10 names) | 2 |
| TopBarMobile | 5 |
| BottomNav | 6 |
| Layout chrome switching + BottomNav routing | 7 |
| MobileCharacterBar | 11 |
| MobileMechanicsFab | 12 |
| NarrativePane `compact` (padding + quick-action hidden) | 10 |
| CharacterPane `compact` (no sticky chrome) | 8 |
| MechanicsPane `compact` (no sticky chrome) | 9 |
| game-client.tsx mobile branch | 13 |
| Regression sweep | 14 |

**Out of scope** (deliberately not in this plan):
- Hub, settings, wizards, campaign-detail, landing, invite responsive — phase 2/3.
- UA-based SSR detection — accepted SSR-desktop default.
- Custom drag handlers — vaul provides them.

**Risks tracked:**
- vaul / React 19 peer-deps: addressed in Task 1.
- Vaul ESM/CJS interop on build: addressed in Task 14.
- `liveState.combat?.round` typing: addressed in Task 13 Step 4 with a typecheck gate.
