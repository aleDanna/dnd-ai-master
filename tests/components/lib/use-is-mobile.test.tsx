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
