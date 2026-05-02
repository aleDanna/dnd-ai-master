'use client';

/**
 * Module-level coordinator for in-page TTS audio playback.
 *
 * Only one audio element is "active" at a time — when a new one is registered
 * via setActiveAudio, the previous one is paused. Subscribers get notified so
 * UI buttons can revert their visual state when they're preempted.
 */

let activeAudio: HTMLAudioElement | null = null;
type Listener = (audio: HTMLAudioElement | null) => void;
const listeners = new Set<Listener>();

export function setActiveAudio(audio: HTMLAudioElement | null): void {
  const prev = activeAudio;
  activeAudio = audio;
  if (prev && prev !== audio) {
    try {
      prev.pause();
    } catch {
      // already paused / detached
    }
  }
  for (const l of listeners) l(audio);
}

export function getActiveAudio(): HTMLAudioElement | null {
  return activeAudio;
}

export function subscribePlayback(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test-only helper: clears state so tests don't leak across cases. */
export function _resetForTests(): void {
  activeAudio = null;
  listeners.clear();
}
