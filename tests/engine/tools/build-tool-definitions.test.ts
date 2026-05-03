import { describe, it, expect } from 'vitest';
import { buildToolDefinitions } from '@/engine/tools';

describe('buildToolDefinitions', () => {
  it('omits generate_scene_image when imageGenerationEnabled is false', () => {
    const tools = buildToolDefinitions({ imageGenerationEnabled: false });
    expect(tools.find((t) => t.name === 'generate_scene_image')).toBeUndefined();
  });

  it('omits generate_scene_image when the flag is missing', () => {
    const tools = buildToolDefinitions({});
    expect(tools.find((t) => t.name === 'generate_scene_image')).toBeUndefined();
  });

  it('includes generate_scene_image when imageGenerationEnabled is true', () => {
    const tools = buildToolDefinitions({ imageGenerationEnabled: true });
    expect(tools.find((t) => t.name === 'generate_scene_image')).toBeDefined();
  });

  it('still includes the always-on tools regardless of the flag', () => {
    const off = buildToolDefinitions({ imageGenerationEnabled: false });
    const on = buildToolDefinitions({ imageGenerationEnabled: true });
    for (const name of ['roll_d20', 'make_attack', 'apply_damage', 'end_combat', 'award_xp']) {
      expect(off.find((t) => t.name === name), `off: ${name}`).toBeDefined();
      expect(on.find((t) => t.name === name), `on: ${name}`).toBeDefined();
    }
  });
});
