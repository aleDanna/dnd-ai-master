import { describe, it, expect } from 'vitest';
import {
  TTS_PROVIDERS,
  LOCAL_TTS_MODELS,
  XTTS_LANGUAGES,
  isValidTtsProvider,
  isValidTtsModel,
  modelsForProvider,
  defaultModelForProvider,
  defaultVoiceForModel,
  voicesForModel,
  isValidVoiceForModel,
} from '@/lib/tts-voices';

describe('local TTS catalog', () => {
  it('TTS_PROVIDERS includes local', () => {
    expect(TTS_PROVIDERS).toContain('local');
  });

  it('LOCAL_TTS_MODELS is [piper, xtts]', () => {
    expect([...LOCAL_TTS_MODELS]).toEqual(['piper', 'xtts']);
  });

  it('XTTS_LANGUAGES has 9 entries including en and it', () => {
    expect(XTTS_LANGUAGES.length).toBe(9);
    expect(XTTS_LANGUAGES.map((l) => l.code)).toContain('en');
    expect(XTTS_LANGUAGES.map((l) => l.code)).toContain('it');
  });

  it('isValidTtsProvider accepts local', () => {
    expect(isValidTtsProvider('local')).toBe(true);
  });

  it('isValidTtsModel accepts piper and xtts', () => {
    expect(isValidTtsModel('piper')).toBe(true);
    expect(isValidTtsModel('xtts')).toBe(true);
  });

  it('modelsForProvider("local") returns [piper, xtts]', () => {
    expect([...modelsForProvider('local')]).toEqual(['piper', 'xtts']);
  });

  it('defaultModelForProvider("local") is piper', () => {
    expect(defaultModelForProvider('local')).toBe('piper');
  });

  it('voicesForModel("local", "xtts") returns XTTS language codes', () => {
    const voices = voicesForModel('local', 'xtts');
    expect(voices).toContain('en');
    expect(voices).toContain('it');
  });

  it('voicesForModel("local", "piper") returns [] (runtime-discovered)', () => {
    expect(voicesForModel('local', 'piper')).toEqual([]);
  });

  it('defaultVoiceForModel("local", "xtts") is "en"', () => {
    expect(defaultVoiceForModel('local', 'xtts')).toBe('en');
  });

  it('defaultVoiceForModel("local", "piper") falls back to empty (runtime overrides)', () => {
    expect(defaultVoiceForModel('local', 'piper')).toBe('');
  });

  it('isValidVoiceForModel("local", "xtts", code) checks against XTTS_LANGUAGES', () => {
    expect(isValidVoiceForModel('en', 'local', 'xtts')).toBe(true);
    expect(isValidVoiceForModel('xx', 'local', 'xtts')).toBe(false);
  });

  it('isValidVoiceForModel("local", "piper", anything) accepts any non-empty string ≤200 chars', () => {
    expect(isValidVoiceForModel('en_US-amy-low', 'local', 'piper')).toBe(true);
    expect(isValidVoiceForModel('', 'local', 'piper')).toBe(false);
    expect(isValidVoiceForModel('x'.repeat(201), 'local', 'piper')).toBe(false);
  });
});
