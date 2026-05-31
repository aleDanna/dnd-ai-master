import { describe, it, expect } from 'vitest';
import { buildBeginUserMessage } from '@/ai/master/begin-message';

/**
 * The campaign-opener user message. The tonal-frame mandate ("call meta_action
 * set_tonal_frame first") is a BAKED-path concept: on the vault path the
 * meta_action tool is not exposed, tonalFrame is never read, and there is no
 * requiredToolsBeforeEnd enforcement — so ordering it there makes the local
 * model emit `meta_action: {...}` as TEXT instead of narrating, stalling the
 * opening. buildBeginUserMessage therefore gates the mandate behind
 * opts.tonalMandate (default true = baked behavior; vault passes false).
 */

describe('buildBeginUserMessage', () => {
  it('includes the tonal-frame mandate by default (baked path)', () => {
    const msg = buildBeginUserMessage('A dark mill cellar.', 'en');
    expect(msg).toMatch(/meta_action/);
    expect(msg).toMatch(/set_tonal_frame/);
  });

  it('OMITS the tonal mandate when tonalMandate is false (vault path)', () => {
    const msg = buildBeginUserMessage('A dark mill cellar.', 'en', { tonalMandate: false });
    expect(msg).not.toMatch(/meta_action/);
    expect(msg).not.toMatch(/set_tonal_frame/);
    // …but still instructs the model to open the scene.
    expect(msg.toLowerCase()).toMatch(/begin the campaign|open/);
  });

  it('prepends the campaign premise verbatim when present', () => {
    const msg = buildBeginUserMessage('A cramped goblin warren.', 'en', { tonalMandate: false });
    expect(msg).toMatch(/A cramped goblin warren\./);
  });

  it('omits the premise block when premise is empty/null', () => {
    const msg = buildBeginUserMessage('   ', 'en', { tonalMandate: false });
    // Assert on the block header (colon) — the instruction prose itself says
    // "...grounded in the Campaign premise above" (no colon), so a bare
    // /Campaign premise/ would false-match even when no premise block exists.
    expect(msg).not.toMatch(/Campaign premise:/);
  });

  it('uses the Italian opener for language "it"', () => {
    const msg = buildBeginUserMessage('Una cantina buia.', 'it', { tonalMandate: false });
    expect(msg).toMatch(/Inizia la campagna/);
  });

  it('falls back to English for an unknown language', () => {
    const msg = buildBeginUserMessage('x', 'zz', { tonalMandate: false });
    expect(msg.toLowerCase()).toMatch(/begin the campaign/);
  });
});
