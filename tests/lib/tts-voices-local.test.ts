import { describe, it, expect } from 'vitest';
import {
  TTS_PROVIDERS,
  LOCAL_TTS_MODELS,
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

  it('LOCAL_TTS_MODELS is [piper]', () => {
    expect([...LOCAL_TTS_MODELS]).toEqual(['piper']);
  });

  it('isValidTtsProvider accepts local', () => {
    expect(isValidTtsProvider('local')).toBe(true);
  });

  it('isValidTtsModel accepts piper', () => {
    expect(isValidTtsModel('piper')).toBe(true);
  });

  it('modelsForProvider("local") returns [piper]', () => {
    expect([...modelsForProvider('local')]).toEqual(['piper']);
  });

  it('defaultModelForProvider("local") is piper', () => {
    expect(defaultModelForProvider('local')).toBe('piper');
  });

  it('voicesForModel("local", "piper") returns [] (runtime-discovered)', () => {
    expect(voicesForModel('local', 'piper')).toEqual([]);
  });

  it('defaultVoiceForModel("local", "piper") falls back to empty (runtime overrides)', () => {
    expect(defaultVoiceForModel('local', 'piper')).toBe('');
  });

  it('isValidVoiceForModel("local", "piper", anything) accepts any non-empty string ≤200 chars', () => {
    expect(isValidVoiceForModel('en_US-amy-low', 'local', 'piper')).toBe(true);
    expect(isValidVoiceForModel('', 'local', 'piper')).toBe(false);
    expect(isValidVoiceForModel('x'.repeat(201), 'local', 'piper')).toBe(false);
  });
});
