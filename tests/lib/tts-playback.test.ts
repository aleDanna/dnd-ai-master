import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActiveAudio, getActiveAudio, subscribePlayback, _resetForTests } from '@/lib/tts-playback';

function fakeAudio(): HTMLAudioElement {
  return { pause: vi.fn() } as unknown as HTMLAudioElement;
}

describe('tts-playback coordinator', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('starts with no active audio', () => {
    expect(getActiveAudio()).toBeNull();
  });

  it('setActiveAudio pauses the previous one and updates active', () => {
    const a = fakeAudio();
    const b = fakeAudio();
    setActiveAudio(a);
    expect(getActiveAudio()).toBe(a);
    setActiveAudio(b);
    expect(getActiveAudio()).toBe(b);
    expect(a.pause).toHaveBeenCalledOnce();
    expect(b.pause).not.toHaveBeenCalled();
  });

  it('setting the same audio twice does not pause itself', () => {
    const a = fakeAudio();
    setActiveAudio(a);
    setActiveAudio(a);
    expect(a.pause).not.toHaveBeenCalled();
  });

  it('setActiveAudio(null) pauses the previous and clears active', () => {
    const a = fakeAudio();
    setActiveAudio(a);
    setActiveAudio(null);
    expect(getActiveAudio()).toBeNull();
    expect(a.pause).toHaveBeenCalledOnce();
  });

  it('subscribers are notified on every change and can unsubscribe', () => {
    const a = fakeAudio();
    const b = fakeAudio();
    const seen: (HTMLAudioElement | null)[] = [];
    const unsub = subscribePlayback((x) => seen.push(x));

    setActiveAudio(a);
    setActiveAudio(b);
    setActiveAudio(null);

    expect(seen).toEqual([a, b, null]);

    unsub();
    setActiveAudio(a);
    expect(seen.length).toBe(3); // no new entry after unsubscribe
  });
});
