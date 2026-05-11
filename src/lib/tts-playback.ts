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

// Separate "loading" channel: while the autoplay coordinator (or any other
// caller) is fetching+decoding the TTS bytes for a message, it can mark that
// message id as loading so the per-message TtsButton can render a spinner
// instead of the stale "Listen" label. Cleared when the audio actually
// starts playing (setActiveAudio) or when the fetch fails / is cancelled.
let loadingMessageId: string | null = null;
type LoadingListener = (messageId: string | null) => void;
const loadingListeners = new Set<LoadingListener>();

export function setLoadingMessageId(messageId: string | null): void {
  if (loadingMessageId === messageId) return;
  loadingMessageId = messageId;
  for (const l of loadingListeners) l(messageId);
}

export function getLoadingMessageId(): string | null {
  return loadingMessageId;
}

export function subscribeLoading(fn: LoadingListener): () => void {
  loadingListeners.add(fn);
  return () => {
    loadingListeners.delete(fn);
  };
}

export function setActiveAudio(audio: HTMLAudioElement | null, messageId?: string | null): void {
  const prev = activeAudio;
  activeAudio = audio;
  activeMessageId = audio ? (messageId ?? null) : null;
  // Audio is now playing (or cleared) — clear the loading flag if it matched.
  if (audio && messageId && loadingMessageId === messageId) {
    loadingMessageId = null;
    for (const l of loadingListeners) l(null);
  }
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
  loadingMessageId = null;
  listeners.clear();
  loadingListeners.clear();
}
