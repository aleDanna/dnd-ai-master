import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

/**
 * Single source of truth for the vault filesystem root.
 *
 * Resolved once at module-load to a stable absolute path under the project's
 * working directory. All vault reads pass through this constant.
 */
export const VAULT_ROOT = resolve(process.cwd(), 'data/vault');

/**
 * REQ-014 — Path sanitization for every vault read (validated by spike 001).
 *
 * Returns the absolute path inside the vault root when `input` is safe,
 * `null` otherwise. Rejects: traversal (`../`), absolute paths outside the
 * root, null bytes, and symlinks that escape the root. Falls back to a
 * lexical prefix check when the path does not yet exist (so the function
 * is usable for "does this path even resolve safely" probes).
 *
 * The optional `root` parameter is a test seam; production callers omit it
 * and the function uses `VAULT_ROOT`.
 */
export async function safeVaultPath(input: string, root: string = VAULT_ROOT): Promise<string | null> {
  if (typeof input !== 'string' || input.length === 0) return null;
  // Null byte injection: a single \0 in any segment short-circuits the check.
  if (input.indexOf('\0') !== -1) return null;

  // Strip leading slashes so the LLM-provided "/handbook/foo.md" and
  // "handbook/foo.md" forms both resolve under root.
  const stripped = input.replace(/^\/+/, '');
  const candidate = normalize(join(root, stripped));

  // Lexical guard: candidate must be the root itself OR a child path.
  // `path.sep` boundary prevents `/data/vault-evil` from passing a naive prefix.
  const rootWithSep = root.endsWith('/') ? root : root + '/';
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;

  // Symlink-escape guard: if the path exists, resolve via realpath and
  // re-check the prefix. The root itself must also be resolved — on macOS
  // tmpdir() returns paths under /var/folders/... that are symlinks into
  // /private/var/folders/..., so a naive prefix check between root
  // (unresolved) and candidate (resolved) produces false negatives.
  try {
    const real = await realpath(candidate);
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      // root doesn't exist or is inaccessible; lexical guard above already
      // proved the candidate is under the literal root path, so accept.
      return candidate;
    }
    const realRootWithSep = realRoot.endsWith('/') ? realRoot : realRoot + '/';
    if (real !== realRoot && !real.startsWith(realRootWithSep)) return null;
  } catch {
    // ENOENT / EACCES on candidate — the path does not exist or is
    // inaccessible, which is fine for safety: nothing to escape to.
  }

  return candidate;
}

/**
 * REQ-014 — Read a file from the vault by LLM-supplied path (validated by spike 001).
 *
 * Returns the file contents on success, OR a literal error marker string on
 * any failure. Never throws — the LLM must see these markers as tool results,
 * not 500s bubbling up to the turn loop.
 */
export async function readVaultFile(input: string, root: string = VAULT_ROOT): Promise<string> {
  const safe = await safeVaultPath(input, root);
  if (safe === null) return 'ERROR: path outside vault';
  try {
    return await readFile(safe, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return `ERROR: file not found at ${input}`;
    return `ERROR: cannot read ${input}`;
  }
}

/**
 * REQ-014 — List immediate children of a vault directory (validated by spike 001).
 *
 * Returns a sorted array of entry names (immediate children only — no
 * recursive walk). Returns `[]` for unsafe paths, missing directories, or
 * any read failure. Never throws.
 */
export async function listVaultDir(input: string, root: string = VAULT_ROOT): Promise<string[]> {
  const safe = await safeVaultPath(input, root);
  if (safe === null) return [];
  try {
    const entries = await readdir(safe);
    return entries.slice().sort();
  } catch {
    return [];
  }
}
