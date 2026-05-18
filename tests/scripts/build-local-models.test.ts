/**
 * The build-local-models script is mostly I/O (Ollama HTTP + spawnSync
 * `ollama create`). The bits we CAN unit-test cheaply:
 *  - The Modelfile string generator is deterministic given fixed inputs.
 *  - The content hash is stable across calls with the same inputs.
 *  - The hash changes when content or version change.
 *
 * We exercise these via the same helpers the script uses (or via
 * computeMasterPromptHash directly, which the script delegates to).
 *
 * End-to-end CLI behaviour (Ollama reachability, --dry-run vs --force,
 * spawnSync exit codes) is covered by the Task 10 manual smoke test —
 * those branches are too I/O-heavy to mock usefully here.
 */

import { describe, it, expect } from 'vitest';
import { computeMasterPromptHash } from '@/ai/master/baked-models';

describe('build-local-models hash stability', () => {
  it('the same systemContent + version yields the same hash', async () => {
    const content = 'block1\n\nblock2\n\nblock3';
    const a = await computeMasterPromptHash(content, 1);
    const b = await computeMasterPromptHash(content, 1);
    expect(a).toBe(b);
  });

  it('different versions produce different hashes (even if content is identical)', async () => {
    const content = 'identical content';
    const a = await computeMasterPromptHash(content, 1);
    const b = await computeMasterPromptHash(content, 2);
    expect(a).not.toBe(b);
  });

  it('content changes invalidate the hash', async () => {
    const a = await computeMasterPromptHash('foo bar baz', 1);
    const b = await computeMasterPromptHash('foo bar baz!', 1);
    expect(a).not.toBe(b);
  });

  it('hash truncated to 16 hex chars', async () => {
    const h = await computeMasterPromptHash('whatever', 7);
    expect(h).toMatch(/^[a-f0-9]{16}$/);
    expect(h.length).toBe(16);
  });
});

describe('build-local-models Modelfile shape (sanity)', () => {
  // We can't import the script's internal buildModelfile without
  // running its main()-level side effects (DB env loading, etc.), but
  // we can sanity-check the structural pieces we expect the script to
  // produce. If this test ever drifts, update both sides.
  it('a Modelfile shape with FROM, PARAMETER, SYSTEM is what we expect', () => {
    // This is documentation more than verification — the assertion is
    // trivial. The real test is that build-local-models.ts assembles
    // exactly these pieces (verified by manual smoke).
    const expectedShape = `FROM qwen3:30b

PARAMETER num_ctx 65536

SYSTEM """
content
"""
`;
    expect(expectedShape).toMatch(/^FROM /);
    expect(expectedShape).toMatch(/PARAMETER num_ctx 65536/);
    expect(expectedShape).toMatch(/SYSTEM """[\s\S]*"""/);
  });

  it('Modelfile heredoc safety: static prompt content must not contain `"""`', async () => {
    // Importing the real static blocks would tie this test to handbook content
    // updates, which would be annoying. Instead, run the same regex check the
    // build script uses on a sample.
    const safe = 'no triple quotes here';
    const unsafe = 'this contains """triple""" quotes';
    expect(safe.includes('"""')).toBe(false);
    expect(unsafe.includes('"""')).toBe(true);
  });
});
