/**
 * Per-campaign path resolution under `VAULT_CAMPAIGNS_ROOT` (REQ-007).
 *
 * Phase 02 NEVER writes to `VAULT_ROOT` — that's the static handbook root,
 * repo-committed. The two roots are strictly disjoint. Every mutation that
 * lands on disk in Phase 02 flows through this module, which means:
 *   1. Path resolution is centralized and grep-auditable.
 *   2. The UUID guard (T-02-04 mitigation) runs at the entry point —
 *      non-UUID `campaignId` input from an LLM hallucination, stray test
 *      value, or env injection short-circuits before any filesystem call.
 *   3. The character-name slug helper (T-02-05 mitigation) strips any
 *      `[^a-z0-9-]` characters so traversal sequences like `../etc/passwd`
 *      collapse into a safe slug (`etc-passwd`) that lives strictly under
 *      the campaign's `characters/` directory.
 *   4. The path-prefix invariant (T-02-07 mitigation) is asserted in
 *      `characterViewPath` as belt-and-suspenders: the slug strip should
 *      make escape impossible, but the assertion documents the invariant
 *      for future maintainers and catches regressions if the slug helper
 *      is ever weakened.
 *
 * Character view filenames include an `-<id8>` suffix per phase Decision 10
 * — defends against name-slug collisions (e.g., "Ára" and "Ara" both slugify
 * to `ara`) at zero ergonomic cost.
 *
 * `assertSameVolumeForTempFiles()` is the runtime invariant from RESEARCH
 * Pitfall 1. It runs once at module load, compares the device id of
 * `VAULT_CAMPAIGNS_ROOT` to `os.tmpdir()`, and logs a `console.warn` when
 * they differ. Phase 02 doesn't use tmp+rename atomic writes (`appendFile`
 * only) so the mismatch is informational; the warning informs Phase 03
 * planners. The check is best-effort: if `VAULT_CAMPAIGNS_ROOT` does not
 * yet exist, the function silently exits (the directory is created lazily
 * by the first `EventsWriter.applyEvent` via `mkdir -p`).
 *
 * The module imports `VAULT_CAMPAIGNS_ROOT` from `./path` — that constant
 * already reads `process.env.VAULT_CAMPAIGNS_ROOT` at module-load (Phase 01
 * export); this module CONSUMES it, never redefines it.
 */
import { join, resolve, sep } from 'node:path';
import { VAULT_CAMPAIGNS_ROOT } from './path';

/**
 * RFC 4122 UUID format (case-insensitive). Matches the `uuid().defaultRandom()`
 * shape produced by `src/db/schema/campaigns.ts` (`campaigns.id`). Used by
 * `campaignDir()` and `characterViewPath()` to fail-closed before touching
 * the filesystem (T-02-04 mitigation: defense-in-depth against LLM-supplied
 * IDs even though the dispatcher resolves `campaignId` from server-side
 * session context, not LLM input).
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the absolute path of a campaign's directory under
 * `VAULT_CAMPAIGNS_ROOT`. Throws when `campaignId` is not a valid UUID —
 * any caller that wants to "soft-fail" must wrap the call in its own
 * try/catch. The hard throw is intentional (T-02-04: fail-closed at the
 * boundary; do not silently fall through to a filesystem call with a
 * traversable input).
 */
export function campaignDir(campaignId: string): string {
  if (!UUID_REGEX.test(campaignId)) {
    throw new Error(`campaignDir: campaignId must be a UUID, got: ${campaignId}`);
  }
  // `resolve` produces an absolute, normalized path. The UUID regex above
  // already rejects `..` segments and path separators, so there is no
  // residual traversal surface.
  return resolve(VAULT_CAMPAIGNS_ROOT, campaignId);
}

/**
 * Absolute path of a campaign's append-only events log
 * (`<VAULT_CAMPAIGNS_ROOT>/<campaignId>/events.md`). Inherits the UUID
 * guard from `campaignDir`. Used by `EventsWriter.applyEvent(...)` as the
 * mutex key (one mutex per resolved absolute path).
 */
export function eventsPath(campaignId: string): string {
  return join(campaignDir(campaignId), 'events.md');
}

/**
 * Strip a character name to a filesystem-safe slug.
 *
 * Steps (in order):
 *   1. `toLowerCase()`     — case-fold so `Aragorn` and `aragorn` collide
 *                            (acceptable: the `-id8` suffix disambiguates).
 *   2. `normalize('NFD')`  — decompose composed characters into base +
 *                            combining marks (`A`-with-acute becomes
 *                            base `A` + U+0301 combining acute).
 *   3. strip `̀-ͯ` — drop the combining diacritic block. The
 *                            range MUST be written as explicit Unicode
 *                            escape codes (NIT 5); a literal combining-
 *                            diacritic range copy-pastes unreliably
 *                            through source-editor encodings and
 *                            terminal display.
 *   4. replace `[^a-z0-9-]+` with `-` — collapse runs of non-alphanumeric
 *                            characters (including `/`, `.`, spaces) into
 *                            a single hyphen. `../etc/passwd` becomes
 *                            `-etc-passwd` after this step.
 *   5. trim leading/trailing hyphens — produces `etc-passwd`.
 *   6. collapse repeated hyphens — `a---b` becomes `a-b`.
 *   7. empty-result fallback — return `'unnamed'` rather than `''` so the
 *                              eventual filename is never `characters/.md`
 *                              (which is invalid + collides across
 *                              callers).
 */
export function slugifyCharacterName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return slug.length > 0 ? slug : 'unnamed';
}

/**
 * Absolute path of a character's materialized view file under a campaign's
 * `characters/` directory. The filename is `<slug>-<id8>.md` per phase
 * Decision 10 (the 8-char UUID suffix defends against slug collisions like
 * "Ára"/"Ara" without forcing the slug helper to preserve unsafe chars).
 *
 * Validation:
 *   - `campaignId` MUST be a UUID (re-asserted via the throw in
 *     `campaignDir`).
 *   - `characterId` MUST be a UUID (independent check — protects against
 *     a non-UUID character id polluting the filename even when the
 *     campaign id is well-formed).
 *
 * Post-build invariant (T-02-07 mitigation):
 *   The returned path MUST start with `<campaignDir>/characters/`. This is
 *   a belt-and-suspenders assertion: the slug step strips everything that
 *   could escape, but if the slug helper is ever weakened (e.g., someone
 *   "improves" it by allowing dots for filename extensions), the assertion
 *   catches the regression at runtime.
 */
export function characterViewPath(
  campaignId: string,
  characterName: string,
  characterId: string,
): string {
  if (!UUID_REGEX.test(characterId)) {
    throw new Error(`characterViewPath: characterId must be a UUID, got: ${characterId}`);
  }
  const slug = slugifyCharacterName(characterName);
  const id8 = characterId.slice(0, 8);
  const base = campaignDir(campaignId);
  const path = join(base, 'characters', `${slug}-${id8}.md`);
  const charactersPrefix = base + sep + 'characters' + sep;
  if (!path.startsWith(charactersPrefix)) {
    throw new Error(
      `characterViewPath: resolved path '${path}' escapes characters dir '${charactersPrefix}' (T-02-07 invariant)`,
    );
  }
  return path;
}

/**
 * Runtime invariant check (RESEARCH Pitfall 1, T-02-12 informational).
 *
 * Compares the device id (`stat.dev`) of `VAULT_CAMPAIGNS_ROOT` against
 * `os.tmpdir()`. When they differ on POSIX (`darwin` / `linux`), logs a
 * single `console.warn` informing operators that any future tmp+rename
 * atomic-write strategy (Phase 03+) would lose atomicity because POSIX
 * `rename(2)` is atomic only on the same filesystem.
 *
 * The check is intentionally:
 *   - Best-effort (wrapped in try/catch — never throws).
 *   - POSIX-only (Windows `rename(2)` semantics differ; skip there).
 *   - Lazy-tolerant (if `VAULT_CAMPAIGNS_ROOT` does not exist yet, exit
 *     silently — the dir is created on first `mkdir -p` from the writer).
 *
 * Phase 02 itself is safe regardless: `EventsWriter.append` uses
 * `appendFile` only (no rename). The warning is preparation for Phase 03
 * snapshot-and-compact + atomic view rewrite work.
 */
export function assertSameVolumeForTempFiles(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  try {
    // Use require() rather than top-level import so the function remains
    // safe to call in environments where these modules are stubbed at the
    // module-load boundary (e.g., test seams that replace `fs`).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os');
    let campaignsDev: number | undefined;
    try {
      campaignsDev = fs.statSync(VAULT_CAMPAIGNS_ROOT).dev;
    } catch {
      // VAULT_CAMPAIGNS_ROOT does not exist yet (first run before any
      // campaign is flipped). The dir is created lazily by the writer;
      // re-running the check is the operator's responsibility if it
      // matters for their deployment.
      return;
    }
    const tmpDir: string = os.tmpdir();
    const tmpDev: number = fs.statSync(tmpDir).dev;
    if (campaignsDev !== tmpDev) {
      console.warn(
        '[campaign-paths] VAULT_CAMPAIGNS_ROOT (' +
          VAULT_CAMPAIGNS_ROOT +
          ') is on a different volume than os.tmpdir() (' +
          tmpDir +
          '). Phase 02 is safe (no tmp+rename), but Phase 03 atomic writes may require relocating temp files. See RESEARCH Pitfall 1.',
      );
    }
  } catch {
    // Best-effort: never throw from a module-load-time invariant check.
    return;
  }
}

// Fire the same-volume check once per process at module load. The warning
// (when emitted) is informational and never blocks startup.
assertSameVolumeForTempFiles();
