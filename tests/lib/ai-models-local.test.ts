import { describe, it, expect } from 'vitest';
import {
  isKnownProvider,
  isKnownImageProvider,
  isKnownMasterModel,
  isKnownImageModel,
  modelsForProvider,
  imageModelsForProvider,
} from '@/lib/ai-models';

describe('local provider acceptance', () => {
  it('isKnownProvider accepts local', () => {
    expect(isKnownProvider('local')).toBe(true);
    expect(isKnownProvider('anthropic')).toBe(true);
    expect(isKnownProvider('unknown')).toBe(false);
  });

  it('isKnownImageProvider accepts local', () => {
    expect(isKnownImageProvider('local')).toBe(true);
    expect(isKnownImageProvider('openai')).toBe(true);
    expect(isKnownImageProvider('anthropic')).toBe(false);
  });

  it('isKnownMasterModel rejects local slugs at this layer (route-level validates them)', () => {
    expect(isKnownMasterModel('qwen3:30b-a3b')).toBe(false);
    expect(isKnownMasterModel('claude-sonnet-4-5')).toBe(true); // cloud catalog
    expect(isKnownMasterModel('')).toBe(false);
    expect(isKnownMasterModel('x'.repeat(201))).toBe(false);
  });

  it('isKnownImageModel accepts draw-things: prefixed slugs', () => {
    expect(isKnownImageModel('draw-things:realisticVisionV60')).toBe(true);
    expect(isKnownImageModel('comfyui:flux-schnell')).toBe(false);
    expect(isKnownImageModel('local:something-else')).toBe(false);
  });

  it('modelsForProvider("local") returns an empty list (runtime-populated)', () => {
    expect(modelsForProvider('local')).toEqual([]);
  });

  it('imageModelsForProvider("local") returns an empty list', () => {
    expect(imageModelsForProvider('local')).toEqual([]);
  });
});
