# Post-MVP Improvements Backlog

> Tracking issues flagged by the final code reviews of Plan A, Plan B, and Plan C that were intentionally deferred. Plan D adds its own follow-ups to this list as it lands. Once the MVP (Plans A→D) is shipped, work through this backlog before adding new sub-projects (campaigns, multiplayer).

Each entry: **severity** (Critical / Important / Minor), **area**, **effort** (S / M / L), and a concrete fix.

---

## From Plan A — SRD Knowledge Base

### Important

- **A-I1 — Seeder uses `onConflictDoNothing`, not `onConflictDoUpdate`.** [Important · DB · M]
  - File: `src/srd/seed.ts`
  - CSV corrections to existing rows are silently ignored on re-seed. Currently mitigated by `pnpm db:reseed` (TRUNCATE first), but Plan B onward FK's into `srd_*.slug` so a TRUNCATE-CASCADE will become destructive.
  - Fix: convert each insert to `onConflictDoUpdate({ target: <slug>, set: { … } })` with `excluded.<col>` shorthand for every non-slug column. Keep the policy comment block in `seed.ts`.

### Minor

- **A-M1 — `srd_race.ageNote` drifts from spec §3.1.** [Minor · doc · S]
  - File: `src/db/schema/srd-race.ts`
  - `ageNote` is a deliberate addition beyond the spec. Add a comment.

- **A-M2 — `splitList` helper duplicated across parsers.** [Minor · refactor · S]
  - Files: `src/srd/parsers/classes.ts`, `src/srd/parsers/backgrounds.ts`
  - Extract to `src/srd/util/strings.ts` with a single canonical implementation.

- **A-M3 — Playwright spins up `pnpm dev` on every run.** [Minor · DX · S]
  - File: `playwright.config.ts`
  - Slow local iteration. Consider a `webServer.command` that builds once or document `pnpm test:e2e --reuse-existing-server` workflow.

- **A-M4 — `parseSpellcasting` casts `type` without enum guard.** [Minor · validation · S]
  - File: `src/srd/parsers/classes.ts:40`
  - If a future CSV adds `'Innate'`, the row will pass parsing but the jsonb won't match the declared `$type`.
  - Fix: add a runtime check against the allowed `['Full','Half','Third','Pact']` set; throw on mismatch.

- **A-M5 — `numeric` columns return strings from Drizzle.** [Minor · doc · S]
  - File: `src/db/schema/srd-monster.ts:26`
  - `cr` is `numeric(6,4)`; Drizzle returns it as `string`. Plan B's tests already cast via `Number(...)`. Add a code comment so Plan D authors don't get surprised.

- **A-M6 — Smoke pages used `dynamic = 'force-dynamic'`.** [Minor · perf · S]
  - Now obsolete since Plan C deleted the smoke pages. The pattern remains in `src/app/(authed)/hub/page.tsx` and `src/app/(authed)/characters/[id]/page.tsx` — both correct (dynamic by user). No fix needed; for SRD-browser pages added later, prefer static rendering with on-demand revalidation.

---

## From Plan B — Game Engine

### Important

- **B-I1 — `apply_damage` mutation name overloaded.** [Important · API design · M]
  - Files: `src/engine/types.ts:137`, `src/engine/combat/attack.ts:47`, `src/engine/tools/handlers.ts:93-105`
  - `makeAttack` emits `{op:'apply_damage', amount: finalDamage}` where `finalDamage` is **post-resistance**. The `apply_damage` *tool handler* runs resistance again before emitting `set_hp`. A naive Plan D applicator that calls `applyDamage()` on every `apply_damage` mutation will halve damage twice.
  - Fix: rename the mutation `op` to `subtract_hp` (purely additive arithmetic, applicator just subtracts), reserving `apply_damage` for the tool name. Or document the contract loudly in `types.ts`.

- **B-I2 — `applyCondition` mutation always emitted on duplicate.** [Important · semantics · S]
  - File: `src/engine/conditions.ts:9-23`
  - The function emits one `add_condition` mutation even when the slug already exists in `runtime.conditions`. This pushes upsert responsibility onto the applicator. The function comment says "idempotent on duplicate slug" — misleading at the mutation layer.
  - Fix: emit a `remove_condition` + `add_condition` pair on duplicate so the upsert is explicit at the mutation level. Or keep current and add a JSDoc clause in `types.ts` documenting the applicator contract.

### Minor

- **B-M1 — `longRest` has a dead block on spell-slot restoration.** [Minor · cosmetic · S]
  - File: `src/engine/rests.ts:71-74`
  - Dead `if (input.runtime.spellSlotsUsed) { … }` with two trailing comments. Replace with a one-line comment: `// Spell slots: applicator zeros out spellSlotsUsed when it sees a long_rest action.`

- **B-M2 — Damage-modifier logic duplicated.** [Minor · refactor · M]
  - Files: `src/engine/combat/attack.ts:58-63`, `src/engine/combat/damage.ts:14-20`
  - Extract to `src/engine/combat/resistance.ts` with a single `modifyForResistance(amount, type, target)` and call from both. Plan D will likely want PC resistances (rage, items) — easier to extend in one place.

- **B-M3 — `tickConditions.currentRound` is unused.** [Minor · API hygiene · S]
  - File: `src/engine/combat/turn.ts:23-43`
  - `TickConditionsInput.currentRound` is declared but the function decrements `durationRounds` directly. Either drop the field or use it for an absolute end-round computation.

- **B-M4 — `__fixtures__` directory not created.** [Minor · DX · M]
  - The plan listed `src/engine/__fixtures__/{pcs,monsters,states}.ts` but tests inline their own fixtures, leading to ~6 copies of the goblin and ~4 copies of the fighter. Extract.

- **B-M5 — `initiative.ts` line coverage 78%.** [Minor · test · S]
  - File: `src/engine/combat/initiative.ts:28-30`
  - Secondary tiebreakers (DEX score → PC-vs-monster → id sort) only covered for the DEX path. Add 2 cases for PC-vs-monster tie at same DEX, and two PCs with same init+DEX falling through to id sort.

- **B-M6 — `rand.ts` branch coverage 50%.** [Minor · test · S]
  - File: `src/engine/rand.ts:11,21`
  - `max < min` defensive throws are uncovered. One-line `expect(() => defaultRng.intInclusive(5, 1)).toThrow()` closes the gap.

- **B-M7 — `fireball` stub has unused `_input` / `_rng`.** [Minor · cosmetic · S]
  - File: `src/engine/spells.ts:85`
  - Two ESLint warnings (`@typescript-eslint/no-unused-vars`). Either implement `fireball` (Plan D when the AI master needs it) or annotate with `eslint-disable-next-line` with the reason.

---

## From Plan C — Character Wizard + UI Foundation

### Important

- **C-I1 — AI proposal validation server-side missing.** [Important · UX + safety · M]
  - Files: `src/app/api/wizard/ai-propose/route.ts:18-27`, `src/components/wizard/ai-builder-pane.tsx:50`, `src/app/(authed)/characters/new/wizard-client.tsx:34-72`
  - When Claude returns a hallucinated slug (e.g. `'dragonborn-purple'`), the route forwards it as-is and `handleAccept` dispatches the bad value to the wizard reducer. The wizard then holds an invalid state until save (where validate.ts catches it) — silent UX failure.
  - Fix: in `route.ts`, validate `proposal.value` after `proposeOne()` against the same SRD lists used for the wizard's final validation. For race/class/background → assert string in slug list. For abilities → assert object with 6 keys numeric in 3..18. For skills → assert array of valid Skill literals. For equipment → assert `'kit' | 'gold'`. Return 422 on mismatch with clear error.
  - **Will be addressed in Plan D when ANTHROPIC_API_KEY is wired live.** (deferred from Plan C review)

### Minor

- **C-M1 — Tailwind installed but unused at runtime.** [Minor · doc · S]
  - File: `src/app/globals.css`
  - Every component uses `style={{ … }}` ports of the design prototype. Tailwind utilities aren't used. Keeping inline styles is fine (design parity is reviewable in diff), but the wasted infrastructure is non-obvious. Add a one-line comment: `/* @theme block reserved for future Tailwind utility usage; design tokens drive all current styling. */`

- **C-M2 — Abilities step `parseInt('' || '0')` snaps cleared input to 3.** [Minor · UX nit · S]
  - File: `src/components/wizard/steps/abilities-step.tsx:68`
  - User clears input → value resets to 3 (Math.max clamp). A nicer fix is intermediate string state. Defer to a polish pass.

- **C-M3 — AI Builder has no rate limit or prompt length cap.** [Minor · cost control · S]
  - File: `src/app/api/wizard/ai-propose/route.ts`
  - An authenticated user can post arbitrarily large prompts, costing $$ per call against your Anthropic key. For MVP, gate is Clerk; for production, add `if (body.userPrompt.length > 2000) return new Response(…, {status: 413})` next to the missing-fields guard.

- **C-M4 — `validateWizardState` doesn't enforce skill count or ability method.** [Minor · validation · M]
  - File: `src/characters/validate.ts`
  - A user could submit 0 skills or 5 skills (fighter should pick exactly 2). A user could pick `pointbuy` and submit standard-array values. The validator silently accepts. Plan D's encounters won't break (skillBonus returns wrong values but doesn't throw).
  - Fix: per-class skill-count enforcement (read from SRD `srd_class.proficiencies.skillsChoose`), and per-method validation (standard array → exact `STANDARD_ARRAY` distribution; pointbuy → 27-point cost; rolled → no constraint).

- **C-M5 — Hub TopBar's "Campaigns" and "Characters" both link to `/hub`.** [Minor · UX · S]
  - File: `src/components/layout/top-bar.tsx:35`
  - Placeholder routing. Once campaign-management ships (post-MVP plan #5), wire to `/campaigns` and `/characters` separately.

- **C-M6 — AI proposal endpoint logs nothing.** [Minor · audit · S]
  - File: `src/ai/wizard/loop.ts`
  - Plan B pitched "full audit trail" as a marketing pillar. Cheapest hook: `console.info({ step, userPromptLen: input.userPrompt.length, ms: Date.now() - t0 })` after the API call. Plan D will need this anyway for the master loop; reuse pattern.

- **C-M7 — `tokens.css` font references fragile.** [Minor · doc · S]
  - File: `src/styles/tokens.css:45-47`
  - Tokens reference `var(--font-cormorant)` etc., which only exist if `app/layout.tsx` sets them on `<html>`. Add a comment near the font-family declarations: `/* font vars are wired by next/font in src/app/layout.tsx; do not remove */`.

---

## Cross-cutting

- **X-1 — No CI workflow.** [Important · ops · M]
  - Currently all checks (typecheck, test, lint, e2e, db:migrate) run only locally. Add `.github/workflows/ci.yml` running these on PRs to `main`, plus a workflow that applies migrations to the Vercel preview Neon branch on PR open.

- **X-2 — No Anthropic API cost telemetry.** [Important · ops · M]
  - The MVP spec §7.3 promises an `ai_usage` table tracking input/output/cache tokens per call. Plan D-Backend will create this table. Once live, add a small `/admin/usage` page (or daily Slack/email summary) so the developer can monitor spend.

- **X-3 — No automated tests for Clerk-authenticated flows.** [Minor · test · L]
  - Plan C's E2E covers landing + auth redirect, but not "signed-in user creates a character". Setting up a Clerk testing token (https://clerk.com/docs/testing/playwright/overview) unlocks Playwright-driven coverage of Hub, wizard, and game session.

- **X-4 — `next-forge` patterns deferred.** [Minor · architecture · L]
  - The MVP is a single Next.js app. As campaigns/multiplayer arrive, consider adopting `next-forge`'s monorepo pattern (separate packages for `@repo/db`, `@repo/auth`, `@repo/engine`, `@repo/ui`). Vercel's `vercel:next-forge` skill has the migration playbook.

- **X-5 — Mobile-responsive UI deferred.** [Minor · UX · L]
  - Per design handoff: desktop-first only. After Plan D ships, do a responsive pass on Hub, wizard, and game screen. Tailwind is already installed and ready.

- **X-6 — Light theme (`.scribe`) defined but not enabled.** [Minor · UX · S]
  - `tokens.css` has the full `html.scribe { … }` block. To enable, add a theme switcher button (or auto-detect via `prefers-color-scheme`) that toggles a class on `<html>`.

---

## How to use this list

1. After Plan D ships and the MVP is end-to-end functional, **review this file**.
2. Group related items into small follow-up PRs (e.g. one "engine refactor" PR for B-I1, B-I2, B-M2).
3. Tackle Important items first, then Minor items as polish before kickoff of post-MVP plans (#5 campaigns, #6 multiplayer).
4. As Plan D's review surfaces new follow-ups, append them to a "Plan D" section here.
