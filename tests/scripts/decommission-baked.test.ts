/**
 * tests/scripts/decommission-baked.test.ts — unit + CLI smoke tests for
 * the Phase 03-C-06 `scripts/decommission-baked.ts` operator script.
 *
 * The script's main() shells out to `ollama list` / `ollama rm`, both of
 * which are I/O against a daemon we cannot assume in a test environment.
 * We test the pure pieces directly (MODELS_TO_REMOVE contract,
 * parseOllamaList shape, parseArgs flag handling) and exercise the CLI's
 * --help + --dry-run + invalid-arg paths via spawnSync — those branches
 * do NOT require the Ollama daemon (`--help` exits before any I/O,
 * `--dry-run` exits after parsing `ollama list` but BEFORE any `rm`).
 *
 * For environments without an ollama binary, the dry-run smoke is gated
 * by a probe — Ollama presence is required for that branch.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  MODELS_TO_REMOVE,
  parseArgs,
  parseOllamaList,
} from '../../scripts/decommission-baked';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/decommission-baked.ts');
const TSX_BIN = resolve(process.cwd(), 'node_modules/.bin/tsx');

function ollamaAvailable(): boolean {
  try {
    execSync('ollama --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('decommission-baked MODELS_TO_REMOVE contract (REQ-033 Decision 8)', () => {
  it('contains exactly 5 entries — the 4 retired tier variants + nomic-embed-text', () => {
    expect(MODELS_TO_REMOVE).toHaveLength(5);
  });

  it('removes dnd-master-lite (~3GB)', () => {
    const entry = MODELS_TO_REMOVE.find((m) => m.name === 'dnd-master-lite');
    expect(entry).toBeDefined();
    expect(entry!.sizeNote).toBe('~3GB');
  });

  it('removes dnd-master-max (~14GB)', () => {
    const entry = MODELS_TO_REMOVE.find((m) => m.name === 'dnd-master-max');
    expect(entry).toBeDefined();
    expect(entry!.sizeNote).toBe('~14GB');
  });

  it('removes dnd-master-max2 (~18GB)', () => {
    const entry = MODELS_TO_REMOVE.find((m) => m.name === 'dnd-master-max2');
    expect(entry).toBeDefined();
    expect(entry!.sizeNote).toBe('~18GB');
  });

  it('removes dnd-master-max3 (~18GB)', () => {
    const entry = MODELS_TO_REMOVE.find((m) => m.name === 'dnd-master-max3');
    expect(entry).toBeDefined();
    expect(entry!.sizeNote).toBe('~18GB');
  });

  it('removes nomic-embed-text (~270MB) — RAG embedder per Decision 7', () => {
    const entry = MODELS_TO_REMOVE.find((m) => m.name === 'nomic-embed-text');
    expect(entry).toBeDefined();
    expect(entry!.sizeNote).toBe('~270MB');
  });

  it('PRESERVES dnd-master-plus — regression baseline per REQ-033', () => {
    const names = MODELS_TO_REMOVE.map((m) => m.name);
    expect(names).not.toContain('dnd-master-plus');
  });

  it('PRESERVES production primary qwen3:30b-a3b-instruct-2507-q4_K_M (REQ-030)', () => {
    const names = MODELS_TO_REMOVE.map((m) => m.name);
    expect(names).not.toContain('qwen3:30b-a3b-instruct-2507-q4_K_M');
  });

  it('PRESERVES quality fallback qwen3:30b-a3b-instruct-2507 (REQ-031)', () => {
    const names = MODELS_TO_REMOVE.map((m) => m.name);
    expect(names).not.toContain('qwen3:30b-a3b-instruct-2507');
  });

  it('PRESERVES offline content tool mistral-small3.2:24b (REQ-032)', () => {
    const names = MODELS_TO_REMOVE.map((m) => m.name);
    expect(names).not.toContain('mistral-small3.2:24b');
  });
});

describe('decommission-baked parseArgs', () => {
  it('defaults to interactive (yes=false, dryRun=false, help=false)', () => {
    const args = parseArgs([]);
    expect(args).toEqual({ yes: false, dryRun: false, help: false });
  });

  it('--yes sets yes=true', () => {
    const args = parseArgs(['--yes']);
    expect(args.yes).toBe(true);
  });

  it('-y alias sets yes=true', () => {
    const args = parseArgs(['-y']);
    expect(args.yes).toBe(true);
  });

  it('--dry-run sets dryRun=true', () => {
    const args = parseArgs(['--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('--help sets help=true', () => {
    const args = parseArgs(['--help']);
    expect(args.help).toBe(true);
  });

  it('-h alias sets help=true', () => {
    const args = parseArgs(['-h']);
    expect(args.help).toBe(true);
  });

  it('combining --yes and --dry-run is allowed (dry-run wins at runtime)', () => {
    const args = parseArgs(['--yes', '--dry-run']);
    expect(args.yes).toBe(true);
    expect(args.dryRun).toBe(true);
  });
});

describe('decommission-baked parseOllamaList', () => {
  it('parses a typical `ollama list` table to a Set of names', () => {
    const stdout = [
      'NAME                              ID            SIZE      MODIFIED',
      'dnd-master-plus:latest            ab12cd34      11 GB     2 days ago',
      'qwen3:30b-a3b-instruct-2507       ef56ab78      19 GB     3 weeks ago',
      'nomic-embed-text                  0a1b2c3d      270 MB    1 month ago',
    ].join('\n');
    const set = parseOllamaList(stdout);
    // :latest suffix normalized away
    expect(set.has('dnd-master-plus')).toBe(true);
    expect(set.has('qwen3:30b-a3b-instruct-2507')).toBe(true);
    expect(set.has('nomic-embed-text')).toBe(true);
    // NAME header row excluded
    expect(set.has('NAME')).toBe(false);
  });

  it('skips blank lines', () => {
    const stdout = ['NAME  ID  SIZE  MODIFIED', '', '   ', 'foo  x  1GB  now'].join('\n');
    const set = parseOllamaList(stdout);
    expect(set.size).toBe(1);
    expect(set.has('foo')).toBe(true);
  });

  it('returns empty set on empty stdout (no models installed)', () => {
    const set = parseOllamaList('NAME  ID  SIZE  MODIFIED\n');
    expect(set.size).toBe(0);
  });

  it('handles models WITHOUT the :latest suffix unchanged', () => {
    const stdout = 'NAME  ID  SIZE\ndnd-master-lite  x  3GB';
    const set = parseOllamaList(stdout);
    expect(set.has('dnd-master-lite')).toBe(true);
  });

  it('strips :latest but preserves other tag suffixes (e.g., :30b)', () => {
    const stdout = [
      'NAME  ID  SIZE',
      'qwen3:30b  a  18GB',
      'qwen3:30b:latest  b  18GB',
    ].join('\n');
    const set = parseOllamaList(stdout);
    expect(set.has('qwen3:30b')).toBe(true);
    // The second line normalizes to `qwen3:30b` (same as the first row),
    // so the Set still contains the canonical name.
    expect(set.size).toBe(1);
  });
});

describe('decommission-baked CLI surface', () => {
  it('--help exits 0 and prints usage', () => {
    const r = spawnSync(TSX_BIN, [SCRIPT_PATH, '--help'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').toString()).toMatch(/Usage:/);
    expect((r.stdout ?? '').toString()).toMatch(/--dry-run/);
  });

  it('unknown argument exits 2', () => {
    const r = spawnSync(TSX_BIN, [SCRIPT_PATH, '--bogus-flag'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(r.status).toBe(2);
    expect((r.stderr ?? '').toString()).toMatch(/Unknown argument: --bogus-flag/);
  });

  // Dry-run smoke: requires ollama binary present (the script calls
  // `ollama list` before printing the dry-run lines). Gate to skip on
  // CI hosts that don't have Ollama.
  const ollamaPresent = ollamaAvailable();
  (ollamaPresent ? it : it.skip)('--dry-run lists targets without invoking `ollama rm`', () => {
    const r = spawnSync(TSX_BIN, [SCRIPT_PATH, '--dry-run'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(r.status).toBe(0);
    const stdout = (r.stdout ?? '').toString();
    // Header announces dry-run mode explicitly
    expect(stdout).toMatch(/DRY RUN — no models will be removed/);
    // Each model either prints `would remove` (installed) or `not installed`
    for (const m of MODELS_TO_REMOVE) {
      const removedLine = new RegExp(`would remove ${m.name}`);
      const skipLine = new RegExp(`\\[skip\\] ${m.name}.*not installed`);
      expect(stdout).toMatch(new RegExp(`(${removedLine.source})|(${skipLine.source})`));
    }
    // Final summary present
    expect(stdout).toMatch(/decommission summary/);
  });
});
