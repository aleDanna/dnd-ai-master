import { describe, it, expect } from 'vitest';
import { dispatchMetaCall } from '@/engine/tools/meta-dispatcher';

describe('dispatchMetaCall', () => {
  it('passes plain (non-meta) tool calls through unchanged', () => {
    const r = dispatchMetaCall('roll_dice', { formula: '2d6' });
    expect(r).toEqual({ resolvedName: 'roll_dice', resolvedInput: { formula: '2d6' } });
  });

  it('rewrites combat_action.attack to make_attack and strips subaction', () => {
    const r = dispatchMetaCall('combat_action', {
      subaction: 'attack',
      attacker: 'pc-001',
      target: 'goblin-1',
      weapon: 'longsword',
    });
    expect(r).toEqual({
      resolvedName: 'make_attack',
      resolvedInput: { attacker: 'pc-001', target: 'goblin-1', weapon: 'longsword' },
    });
  });

  it('rewrites combat_action.condition_apply to apply_condition', () => {
    const r = dispatchMetaCall('combat_action', {
      subaction: 'condition_apply',
      actor: 'pc-001',
      condition: 'poisoned',
    });
    expect(r.resolvedName).toBe('apply_condition');
    expect(r.resolvedInput).toEqual({ actor: 'pc-001', condition: 'poisoned' });
  });

  it('passes through sub-actions whose name matches the underlying tool', () => {
    const r = dispatchMetaCall('rest_action', { subaction: 'short_rest', actors: ['pc-001'] });
    expect(r).toEqual({
      resolvedName: 'short_rest',
      resolvedInput: { actors: ['pc-001'] },
    });
  });

  it('throws when meta call lacks a subaction', () => {
    expect(() => dispatchMetaCall('combat_action', { actor: 'pc-001' }))
      .toThrow(/requires a 'subaction' string/);
  });

  it('throws when subaction is not in the meta\'s enum', () => {
    expect(() => dispatchMetaCall('combat_action', { subaction: 'cast_spell' }))
      .toThrow(/not a valid sub-action for combat_action/);
  });

  it('throws when subaction is not a string', () => {
    expect(() => dispatchMetaCall('combat_action', { subaction: 42 as unknown as string }))
      .toThrow(/requires a 'subaction' string/);
  });

  it('handles meta_action with set_bastion (no rename needed)', () => {
    const r = dispatchMetaCall('meta_action', { subaction: 'set_bastion', name: 'Castello' });
    expect(r.resolvedName).toBe('set_bastion');
    expect(r.resolvedInput).toEqual({ name: 'Castello' });
  });
});
