import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '@/engine/tools';
import {
  META_TOOL_DEFINITIONS,
  META_SUBACTIONS_BY_META,
  META_NAMES,
  resolveSubactionToToolName,
} from '@/engine/tools/meta-tools';

describe('meta-tools — structural invariants', () => {
  it('exposes 8 meta-tools', () => {
    expect(META_TOOL_DEFINITIONS).toHaveLength(8);
    expect(META_NAMES).toHaveLength(8);
  });

  it('every meta-tool has a non-empty enum of sub-actions and a discriminator schema', () => {
    for (const tool of META_TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/_action$/);
      const schema = tool.input_schema as { required?: string[]; properties?: { subaction?: { enum?: string[] } } };
      expect(schema.required).toContain('subaction');
      expect(schema.properties?.subaction?.enum?.length).toBeGreaterThan(0);
    }
  });
});

describe('meta-tools — coverage of ALWAYS_ON', () => {
  it('every ALWAYS_ON tool name is reachable via exactly one meta sub-action', () => {
    const alwaysOnNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    const seen = new Map<string, string>(); // toolName -> meta.subaction

    for (const meta of META_NAMES) {
      const subs = META_SUBACTIONS_BY_META[meta];
      for (const sub of subs) {
        const underlying = resolveSubactionToToolName(meta, sub);
        expect(underlying, `${meta}.${sub} must resolve`).not.toBeNull();
        if (!underlying) continue;
        expect(alwaysOnNames.has(underlying), `${meta}.${sub} → ${underlying} (not in ALWAYS_ON)`).toBe(true);
        expect(seen.has(underlying), `${underlying} is reachable via ${seen.get(underlying)} AND ${meta}.${sub}`).toBe(false);
        seen.set(underlying, `${meta}.${sub}`);
      }
    }

    // All ALWAYS_ON names must be covered.
    const missing = [...alwaysOnNames].filter((n) => !seen.has(n));
    expect(missing, `ALWAYS_ON tools not covered by any meta sub-action: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('resolveSubactionToToolName', () => {
  it('returns null for unknown meta', () => {
    expect(resolveSubactionToToolName('not_a_meta', 'attack')).toBeNull();
  });

  it('returns null for sub-action not in this meta', () => {
    expect(resolveSubactionToToolName('combat_action', 'cast_spell')).toBeNull();
  });

  it('returns the underlying name for combat aliases', () => {
    expect(resolveSubactionToToolName('combat_action', 'initiative')).toBe('roll_initiative');
    expect(resolveSubactionToToolName('combat_action', 'attack')).toBe('make_attack');
    expect(resolveSubactionToToolName('combat_action', 'damage')).toBe('apply_damage');
    expect(resolveSubactionToToolName('combat_action', 'condition_apply')).toBe('apply_condition');
    expect(resolveSubactionToToolName('combat_action', 'swap_target')).toBe('swap_attack_target');
    expect(resolveSubactionToToolName('combat_action', 'falling')).toBe('apply_falling');
  });

  it('returns the sub-action name as-is when no rename is configured', () => {
    expect(resolveSubactionToToolName('rest_action', 'short_rest')).toBe('short_rest');
    expect(resolveSubactionToToolName('narrative_action', 'roll_dice')).toBe('roll_dice');
    expect(resolveSubactionToToolName('meta_action', 'set_bastion')).toBe('set_bastion');
  });
});
