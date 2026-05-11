'use client';

/**
 * Module-level coordinator for in-page TTS audio playback.
 *
 * Only one audio element is "active" at a time — when a new one is registered
 * via setActiveAudio, the previous one is paused. Subscribers get notified so
 * UI buttons can revert their visual state when they're preempted OR adopt
 * the active audio when it belongs to them (auto-play started by the game
 * client for message X must be controllable by TtsButton for that same X).
 */

let activeAudio: HTMLAudioElement | null = null;
let activeMessageId: string | null = null;
type Listener = (audio: HTMLAudioElement | null, messageId: string | null) => void;
const listeners = new Set<Listener>();

export function setActiveAudio(audio: HTMLAudioElement | null, messageId?: string | null): void {
  const prev = activeAudio;
  activeAudio = audio;
  activeMessageId = audio ? (messageId ?? null) : null;
  if (prev && prev !== audio) {
    try {
      prev.pause();
    } catch {
      // already paused / detached
    }
  }
  for (const l of listeners) l(audio, activeMessageId);
}

export function getActiveAudio(): HTMLAudioElement | null {
  return activeAudio;
}

export function getActiveMessageId(): string | null {
  return activeMessageId;
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
  activeMessageId = null;
  listeners.clear();
}
