---
phase: 02
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/ai/master/vault/campaign-paths.ts
  - tests/ai/master/vault/campaign-paths.test.ts
autonomous: true
requirements: [REQ-007]
must_haves:
  truths:
    - "campaignDir(uuid) resolves to a path under VAULT_CAMPAIGNS_ROOT and refuses to resolve for any non-UUID input (fail-closed throw)"
    - "eventsPath(uuid) returns <VAULT_CAMPAIGNS_ROOT>/<uuid>/events.md as an absolute path"
    - "characterViewPath(uuid, name, id) returns <campaignDir>/characters/<slug>-<id8>.md where slug strips all non-[a-z0-9-] chars"
    - "A character name containing '../etc/passwd' is slugified to 'etc-passwd' and the resulting path lives strictly inside the campaign dir (path traversal blocked)"
    - "assertSameVolumeForTempFiles() at module load logs (NOT throws) when VAULT_CAMPAIGNS_ROOT and os.tmpdir() are on different volumes (informational; Phase 02 doesn't use tmp+rename but Phase 03 might)"
  artifacts:
    - path: "src/ai/master/vault/campaign-paths.ts"
      provides: "Per-campaign path resolution + UUID format guard + character slug helper + same-volume invariant check"
      exports: ["campaignDir", "eventsPath", "characterViewPath", "slugifyCharacterName", "assertSameVolumeForTempFiles", "UUID_REGEX"]
  key_links:
    - from: "src/ai/master/vault/campaign-paths.ts"
      to: "src/ai/master/vault/path.ts"
      via: "imports VAULT_CAMPAIGNS_ROOT (Phase 01 export, REQ-007)"
      pattern: "VAULT_CAMPAIGNS_ROOT"
    - from: "src/ai/master/vault/events-writer.ts (plan 02-03)"
      to: "src/ai/master/vault/campaign-paths.ts"
      via: "uses eventsPath(campaignId) to compute mutex key"
      pattern: "eventsPath"
    - from: "src/ai/master/vault/projector.ts (plan 02-04)"
      to: "src/ai/master/vault/campaign-paths.ts"
      via: "uses characterViewPath() to compute view file location"
      pattern: "characterViewPath"
---

# Plan 02-02: Campaign Path Resolver

**Phase:** 02-vault-write-path-event-sourcing
**Wave:** 1 (no dependencies)
**Status:** Pending
**Estimated diff size:** ~120 LOC source + ~110 LOC tests / 2 files

## Goal

Ship `src/ai/master/vault/campaign-paths.ts` — the path resolution module Phase 02 uses for every per-campaign filesystem operation. It exports four helpers (`campaignDir`, `eventsPath`, `characterViewPath`, `slugifyCharacterName`) plus a defensive `assertSameVolumeForTempFiles()` runtime check, and a `UUID_REGEX` used to fail-closed on non-UUID `campaignId` input (T-02-04 mitigation).

All paths resolve under `VAULT_CAMPAIGNS_ROOT` (Phase 01 export from `src/ai/master/vault/path.ts:26-28`). Phase 02 NEVER writes to `VAULT_ROOT` — that's the static handbook root, repo-committed. The two roots are strictly disjoint per REQ-007.

The character-slug pattern includes an `-<id8>` suffix (first 8 chars of the character UUID) per phase Decision 10 — defends against name-slug collisions (e.g., "Ára" and "Ara" both slugify to `ra`) at zero ergonomic cost.

`assertSameVolumeForTempFiles()` is the runtime invariant from RESEARCH Pitfall 1. It runs at module load, compares `fs.statSync(VAULT_CAMPAIGNS_ROOT).dev` to `fs.statSync(os.tmpdir()).dev`, and logs a `console.warn` when they differ. Phase 02 doesn't use tmp+rename atomic writes (`appendFile` only) so the mismatch is non-fatal; the warning informs Phase 03 planners. The check is best-effort: if `VAULT_CAMPAIGNS_ROOT` does not yet exist, the function silently exits (the directory is created lazily by the first `EventsWriter.applyEvent` via `mkdir -p`).

## Requirements satisfied

- **REQ-007** Campaign data lives OUTSIDE the codebase repo under `VAULT_CAMPAIGNS_ROOT` — this plan provides the only resolver that produces paths in that root. Every Phase 02 file operation flows through these helpers.

## Files touched

| File | Action | Why |
|---|---|---|
| `src/ai/master/vault/campaign-paths.ts` | NEW | Per-campaign path resolution + slug helper + UUID guard + same-volume invariant. |
| `tests/ai/master/vault/campaign-paths.test.ts` | NEW | Vitest: path resolution under env override, slug correctness, traversal rejection, UUID guard. |

## Tasks

<task type="auto">
  <name>Task 1: Create campaign-paths.ts</name>
  <files>src/ai/master/vault/campaign-paths.ts</files>
  <read_first>
    - src/ai/master/vault/path.ts (lines 26-28 — VAULT_CAMPAIGNS_ROOT export to import; lines 42-80 — safeVaultPath style reference for path-resolution patterns)
    - .planning/phases/02-vault-write-path-event-sourcing/02-RESEARCH.md (§4 Pattern 4 "Per-campaign path resolution"; §6 Code Example "Per-campaign path resolver"; Pitfall 1 — same-volume invariant)
    - .claude/skills/spike-findings-dnd-ai-master/references/storage-and-mutation.md (lines 18-40 — canonical vault layout)
    - src/db/schema/campaigns.ts (campaigns.id is uuid().primaryKey().defaultRandom() — drizzle UUID type informs the regex)
  </read_first>
  <action>
Create `src/ai/master/vault/campaign-paths.ts` with these exports:

1. **`UUID_REGEX` constant:** `export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;` — matches RFC 4122 UUID format. Used by `campaignDir()` to fail-closed before any filesystem call.

2. **`campaignDir(campaignId: string): string`:** 
   - If `UUID_REGEX.test(campaignId)` is false → throw `new Error('campaignDir: campaignId must be a UUID, got: <campaignId>')`. Per T-02-04 mitigation: fail-closed at the entry point so any non-UUID input (LLM hallucination, stray test value, env injection) short-circuits before touching the filesystem.
   - Otherwise return `resolve(VAULT_CAMPAIGNS_ROOT, campaignId)`. `resolve` produces an absolute, normalized path; `..` segments in `campaignId` are impossible because the regex rejects them.

3. **`eventsPath(campaignId: string): string`:** `return join(campaignDir(campaignId), 'events.md');`. Inherits the UUID guard via `campaignDir`.

4. **`slugifyCharacterName(name: string): string`:**
   - Apply: `name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-')`. The diacritic range MUST be written with explicit `\u0300-\u036f` escape codes (Unicode combining diacritic block) — never as a bare literal range, which round-trips unreliably through copy-paste and source-editor encodings.
   - The `normalize('NFD')` + diacritic strip handles "Ára" → "ara" (then `-id8` suffix from `characterViewPath` disambiguates from "Ara").
   - The `[^a-z0-9-]+` strip converts `../etc/passwd` → `etc-passwd` (path-traversal attempts collapse to a safe slug).
   - The trim + dedup steps produce clean filenames (no leading/trailing/repeated hyphens).
   - If the result is empty (input was all non-alphanumeric), return `'unnamed'` as a fallback (avoid `characters/.md` filename).

5. **`characterViewPath(campaignId: string, characterName: string, characterId: string): string`:**
   - Compute `slug = slugifyCharacterName(characterName)`.
   - Compute `id8 = characterId.slice(0, 8)` (per Decision 10 — first 8 chars of UUID for collision defense).
   - If `!UUID_REGEX.test(characterId)` → throw `new Error('characterViewPath: characterId must be a UUID, got: <characterId>')` (same defensive pattern as `campaignDir`).
   - Return `join(campaignDir(campaignId), 'characters', \`${slug}-${id8}.md\`)`. The double UUID guard (campaign + character) prevents path injection from either axis.
   - Path-prefix assertion: after building, assert `path.startsWith(campaignDir(campaignId) + sep + 'characters' + sep)` — throw if not (T-02-07 mitigation). This is belt-and-suspenders: the slug strip should make it impossible to escape, but the assertion documents the invariant for future maintainers and catches regressions if the slug helper is ever weakened.

6. **`assertSameVolumeForTempFiles(): void`:** 
   - Reads `process.platform` — if NOT `'darwin' | 'linux'`, return early (Windows volume semantics differ; the check is informational on POSIX).
   - Wrap in `try { ... } catch { return; }` — best-effort; never throws (RESEARCH Pitfall 1: the check is informational, not fatal — Phase 02 doesn't use tmp+rename, so cross-volume is currently safe).
   - Inside the try: `const fs = require('node:fs'); const os = require('node:os');`
   - `let campaignsDev: number | undefined; try { campaignsDev = fs.statSync(VAULT_CAMPAIGNS_ROOT).dev; } catch { return; }` — silently exit if VAULT_CAMPAIGNS_ROOT doesn't exist yet (first run before any campaign is flipped).
   - `const tmpDev = fs.statSync(os.tmpdir()).dev;`
   - If `campaignsDev !== tmpDev` → `console.warn('[campaign-paths] VAULT_CAMPAIGNS_ROOT (' + VAULT_CAMPAIGNS_ROOT + ') is on a different volume than os.tmpdir() (' + os.tmpdir() + '). Phase 02 is safe (no tmp+rename), but Phase 03 atomic writes may require relocating temp files. See RESEARCH Pitfall 1.');`
   - Call `assertSameVolumeForTempFiles();` at module load (right after the imports + UUID_REGEX definition) — so the warning fires once per process on a misconfigured deployment.

7. **`import { join, resolve, sep } from 'node:path';`** and **`import { VAULT_CAMPAIGNS_ROOT } from './path';`** — the only imports.

8. **Module-level JSDoc:** mirror `src/ai/master/vault/path.ts` style. Cite REQ-007, Decision 10, Pitfall 1, T-02-04, T-02-05, T-02-07.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/campaign-paths.test.ts && pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File `src/ai/master/vault/campaign-paths.ts` exists with all 5 exports: `campaignDir`, `eventsPath`, `characterViewPath`, `slugifyCharacterName`, `assertSameVolumeForTempFiles`, `UUID_REGEX`
    - `grep -c "throw new Error" src/ai/master/vault/campaign-paths.ts` returns ≥ 2 (UUID guard in campaignDir + characterViewPath)
    - `grep -c "VAULT_CAMPAIGNS_ROOT" src/ai/master/vault/campaign-paths.ts` returns ≥ 2 (import + usage)
    - `pnpm typecheck` exits 0
    - `campaignDir('not-a-uuid')` throws with message containing 'UUID'
    - `campaignDir('11111111-2222-3333-4444-555555555555')` returns an absolute path matching `${VAULT_CAMPAIGNS_ROOT}/11111111-2222-3333-4444-555555555555`
    - `slugifyCharacterName('../etc/passwd')` returns `'etc-passwd'`
    - `slugifyCharacterName('Ára')` returns `'ara'` (lowercased + diacritic stripped)
    - `slugifyCharacterName('!!!')` returns `'unnamed'` (empty-after-strip fallback)
    - `characterViewPath(VALID_UUID, 'Aragorn', VALID_UUID)` returns path matching `/characters/aragorn-${VALID_UUID.slice(0, 8)}\.md$/`
  </acceptance_criteria>
  <done>
    File created. Plans 02-03 (events-writer uses eventsPath), 02-04 (projector uses characterViewPath), 02-07 (dispatcher uses campaignDir) consume this module.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write campaign-paths.test.ts covering UUID guard, slug correctness, path prefix invariant</name>
  <files>tests/ai/master/vault/campaign-paths.test.ts</files>
  <read_first>
    - src/ai/master/vault/campaign-paths.ts (the module under test — just created)
    - tests/ai/master/vault/path.test.ts (style reference — env override pattern with `vi.stubEnv` for VAULT_ROOT; reuse the same approach for VAULT_CAMPAIGNS_ROOT)
    - .planning/phases/01-vault-read-path/SUMMARY.md (line 51 — tests under tests/, NEVER colocated; line 53 — DATABASE_URL required for any test that imports @/lib/preferences. This test does NOT, so no DATABASE_URL needed)
  </read_first>
  <action>
Create `tests/ai/master/vault/campaign-paths.test.ts` (Vitest, default discovery).

The module reads `VAULT_CAMPAIGNS_ROOT` at module-load. To test env override behavior, use Vitest's `vi.resetModules()` + dynamic `import()` after `vi.stubEnv('VAULT_CAMPAIGNS_ROOT', tmpdir())` (the same pattern Phase 01's path.test.ts uses). Restore via `vi.unstubAllEnvs()` in `afterEach`.

Test structure — one top-level `describe('campaign-paths')` with these nested describes:

1. **`describe('UUID_REGEX')`:**
   - `it('matches valid UUIDs')` → `expect(UUID_REGEX.test('11111111-2222-3333-4444-555555555555')).toBe(true)`, also test `expect(UUID_REGEX.test('aabbccdd-eeff-0011-2233-445566778899')).toBe(true)`
   - `it('rejects non-UUID strings')` → `not-a-uuid`, empty string, `'../etc/passwd'`, `'11111111-2222-3333-4444'` (truncated), `'11111111-2222-3333-4444-5555555555550'` (too long) → all `.toBe(false)`

2. **`describe('campaignDir')`:**
   - `it('returns absolute path under VAULT_CAMPAIGNS_ROOT')` → stub env to a tmpdir, dynamic import, assert `campaignDir(VALID_UUID).startsWith(tmpdir())`
   - `it('throws on non-UUID input')` → `expect(() => campaignDir('not-a-uuid')).toThrow(/UUID/)`. Test with empty string, traversal sequence `../foo`, and a random non-UUID string.
   - `it('produces deterministic paths for the same UUID')` → call twice, assert equal
   - `it('produces different paths for different UUIDs')` → two distinct UUIDs, assert inequality

3. **`describe('eventsPath')`:**
   - `it('returns campaignDir + /events.md')` → `expect(eventsPath(VALID_UUID)).toBe(join(campaignDir(VALID_UUID), 'events.md'))`
   - `it('throws on non-UUID input via campaignDir guard')` → `expect(() => eventsPath('not-a-uuid')).toThrow(/UUID/)`

4. **`describe('slugifyCharacterName')`:**
   - `it('lowercases')` → `expect(slugifyCharacterName('Aragorn')).toBe('aragorn')`
   - `it('strips diacritics')` → `expect(slugifyCharacterName('Ára')).toBe('ara')` and `expect(slugifyCharacterName('Élise')).toBe('elise')`
   - `it('replaces non-alphanumeric with hyphen')` → `expect(slugifyCharacterName('Sir Galahad the Pure')).toBe('sir-galahad-the-pure')`
   - `it('collapses repeated hyphens')` → `expect(slugifyCharacterName('a---b')).toBe('a-b')`
   - `it('trims leading/trailing hyphens')` → `expect(slugifyCharacterName('-aragorn-')).toBe('aragorn')`
   - `it('handles traversal attempts safely')` → `expect(slugifyCharacterName('../etc/passwd')).toBe('etc-passwd')` (the `..` and `/` all collapse to hyphens, then trim+dedup)
   - `it('returns "unnamed" for all-non-alphanumeric input')` → `expect(slugifyCharacterName('!!!')).toBe('unnamed')` and `expect(slugifyCharacterName('')).toBe('unnamed')`
   - `it('preserves digits')` → `expect(slugifyCharacterName('player1')).toBe('player1')`

5. **`describe('characterViewPath')`:**
   - `it('includes campaignDir + characters/ + slug-id8.md')` → assert the returned path matches `<campaignDir>/characters/aragorn-<id8>.md`
   - `it('throws on non-UUID campaignId')` → `expect(() => characterViewPath('not-uuid', 'Aragorn', VALID_UUID)).toThrow(/UUID/)`
   - `it('throws on non-UUID characterId')` → `expect(() => characterViewPath(VALID_UUID, 'Aragorn', 'not-uuid')).toThrow(/UUID/)`
   - **`it('rejects traversal via character name')` (T-02-05/T-02-07):** call `characterViewPath(VALID_UUID, '../../../etc/passwd', VALID_CHAR_UUID)`. The slug strips to `etc-passwd`, the id8 suffix is appended, and the resulting path MUST start with `campaignDir(VALID_UUID) + sep + 'characters' + sep` — assert this explicitly so the path-prefix invariant is regression-tested.
   - `it('handles collision disambiguation via id8')` → two characters with the same name but different UUIDs produce different paths (the id8 suffix differs)

6. **`describe('assertSameVolumeForTempFiles')`:**
   - `it('does not throw under any conditions')` → just call it; no assertion needed beyond "doesn't throw". The behavior is informational.
   - `it('returns silently when VAULT_CAMPAIGNS_ROOT does not exist')` → stub env to `/nonexistent/path/that/should/not/exist`, dynamic import, call the function, assert no throw and no `console.warn` (use `vi.spyOn(console, 'warn')`).

Top of file: import `vi, describe, it, expect, beforeEach, afterEach` from `'vitest'`. Define `const VALID_UUID = '11111111-2222-3333-4444-555555555555';` and `const VALID_CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';` at the top of the file for reuse.

Use `mkdtempSync(join(tmpdir(), 'gsd-test-vault-'))` in `beforeEach` to create an isolated test root; `rmSync(testRoot, { recursive: true, force: true })` in `afterEach` to clean up.

Total: 6 describe blocks, ~25 `it` cases.
  </action>
  <verify>
    <automated>pnpm test tests/ai/master/vault/campaign-paths.test.ts -- --reporter=verbose</automated>
  </verify>
  <acceptance_criteria>
    - All ~25 test cases pass
    - `grep -c "VALID_UUID" tests/ai/master/vault/campaign-paths.test.ts` returns ≥ 10 (reused across cases)
    - `grep -c "toThrow" tests/ai/master/vault/campaign-paths.test.ts` returns ≥ 4 (UUID guards × 4 paths)
    - Test file does NOT import from `@/db/` or `@/lib/preferences` (no DATABASE_URL dependency)
    - `unset DATABASE_URL; pnpm test tests/ai/master/vault/campaign-paths.test.ts` exits 0
    - `grep -c "stubEnv" tests/ai/master/vault/campaign-paths.test.ts` returns ≥ 1 (env override pattern matched from path.test.ts)
  </acceptance_criteria>
  <done>
    Tests pass with full coverage of UUID guard, slug correctness, path prefix invariant, and same-volume check. Plans 02-03, 02-04, 02-07 inherit these guarantees.
  </done>
</task>

## Verification (plan-level)

- Command: `pnpm test tests/ai/master/vault/campaign-paths.test.ts` → all cases pass
- Command: `pnpm typecheck` → clean
- Behavior smoke: `pnpm exec tsx -e "process.env.VAULT_CAMPAIGNS_ROOT='/tmp/test-vault'; import('./src/ai/master/vault/campaign-paths.ts').then(m => console.log(m.eventsPath('11111111-2222-3333-4444-555555555555')))"` prints `/tmp/test-vault/11111111-2222-3333-4444-555555555555/events.md`.
- Grep gate: `grep -v '^ *\*' src/ai/master/vault/campaign-paths.ts | grep -c 'UUID_REGEX.test'` returns ≥ 2 (UUID guard applied in both `campaignDir` and `characterViewPath`; JSDoc-only mentions filtered out).

## Open questions

None — the path resolution shape is defined by RESEARCH §4 Pattern 4. The slug + id8 suffix is locked by Decision 10. The UUID guard is mandated by T-02-04.
