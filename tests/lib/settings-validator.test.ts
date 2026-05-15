import { describe, it, expect } from 'vitest';
import { validateSettingsPatch } from '@/lib/preferences';

describe('validateSettingsPatch', () => {
  it('accepts a fully-typed valid patch', () => {
    const res = validateSettingsPatch({
      aiProvider: 'anthropic',
      aiMasterModel: 'claude-sonnet-4-5',
      ttsProvider: 'openai',
      ttsModel: 'gpt-4o-mini-tts',
      ttsVoice: 'onyx',
      manualRolls: true,
      masterGuidanceLevel: 'balanced',
      showDifficultyNumbers: false,
      narrationPace: 'brisk',
      imageGenerationEnabled: true,
      imageStylePreset: 'pastel',
      imageStyleCustom: '',
      imageProvider: 'openai',
      imageModel: 'gpt-image-1',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects unknown provider', () => {
    const res = validateSettingsPatch({ aiProvider: 'mistral' as unknown as 'anthropic' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid-aiProvider');
  });

  it('rejects non-boolean manualRolls', () => {
    const res = validateSettingsPatch({ manualRolls: 'yes' as unknown as boolean });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid-manualRolls');
  });

  it('rejects imageStyleCustom longer than 500 chars', () => {
    const res = validateSettingsPatch({ imageStyleCustom: 'x'.repeat(501) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('imageStyleCustom-too-long');
  });

  it('rejects unknown narrationPace value', () => {
    const res = validateSettingsPatch({ narrationPace: 'slow' as unknown as 'detailed' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid-narrationPace');
  });

  it('accepts an empty patch', () => {
    const res = validateSettingsPatch({});
    expect(res.ok).toBe(true);
  });

  it('accepts ttsAutoplay (used by /api/preferences) without flagging it', () => {
    const res = validateSettingsPatch({ ttsAutoplay: true });
    expect(res.ok).toBe(true);
  });
});
