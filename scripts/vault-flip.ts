#!/usr/bin/env tsx
/**
 * scripts/vault-flip.ts — toggle a campaign between `vault` and `baked`
 * backends without dropping into psql; ALSO toggles `vaultMutations`
 * (Phase 02) with synthetic `campaign_initialized` seed-event emission.
 *
 * Usage:
 *   pnpm vault:flip                                                # list campaigns + their current backend + mutation flag
 *   pnpm vault:flip --id=<uuid> --to=vault                         # set masterBackend=vault
 *   pnpm vault:flip --id=<uuid> --to=baked                         # set masterBackend=baked
 *   pnpm vault:flip --id=<uuid> --enable-mutations                 # set vaultMutations=true + append seed event
 *   pnpm vault:flip --id=<uuid> --to=vault --enable-mutations      # combined: backend AND mutations in one call
 *   pnpm vault:flip --id=<uuid> --disable-mutations                # set vaultMutations=false (events.md is preserved)
 *
 * --enable-mutations / --disable-mutations require --id=<uuid>. They are
 * MUTUALLY EXCLUSIVE — passing both errors out.
 *
 * The seed event (Decision 9) is the synthetic `campaign_initialized`
 * line emitted on the FIRST enable. Payload assembled from Postgres:
 *   - characters.{id, name, hpMax}                    — REQUIRED fields
 *   - session_state.hpCurrent via LEFT JOIN sessions  — OPTIONAL (hp_current)
 *     IMPORTANT: hp_current does NOT live on `characters`. It lives on
 *     `session_state.hpCurrent`, keyed per session. The flip script joins
 *     `sessions.campaignId = campaign.id` then `session_state.sessionId =
 *     sessions.id` and dedups to the most-recent row per character.
 *   - characters.{spellcasting.slotsMax, spellSlotsUsed} → spell_slots — OPTIONAL
 *     Non-casters (spellcasting null) and empty merged records are omitted.
 *
 * Pitfall 5: enabling vaultMutations on a campaign whose masterBackend is
 * still 'baked' is a no-op at runtime. The flag is stored, but the vault
 * tool surface is not exposed. The script warns but proceeds (storage is
 * idempotent; operator may flip masterBackend later).
 *
 * The campaign UUID can be a prefix (first 8 chars) as long as it uniquely
 * identifies one row — the script disambiguates.
 *
 * Uses `_env-loader` so it works wherever `vercel env pull` has populated
 * `.env.production.local` (no shell-level DATABASE_URL export needed).
 */
import './_env-loader';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { campaigns, characters, sessions, sessionState } from '@/db/schema';
import { resolveMasterBackend, isMasterBackend, type MasterBackend } from '@/lib/preferences';
import { EventsWriter } from '@/ai/master/vault/events-writer';
import { regenerateAffectedViews } from '@/ai/master/vault/projector';
import { eventsPath } from '@/ai/master/vault/campaign-paths';
import { EVENT_SCHEMA_VERSION } from '@/ai/master/vault/events-schema';
import type { VaultEventEnvelope, VaultSeedCharacter } from '@/ai/master/vault/events-schema';

interface Args {
  id: string | null;
  to: MasterBackend | null;
  enableMutations: boolean;
  disableMutations: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { id: null, to: null, enableMutations: false, disableMutations: false };
  for (const a of argv) {
    if (a.startsWith('--id=')) args.id = a.slice('--id='.length);
    else if (a.startsWith('--to=')) {
      const raw = a.slice('--to='.length);
      if (!isMasterBackend(raw)) {
        console.error(`Invalid --to=${raw}. Use 'vault' or 'baked'.`);
        process.exit(2);
      }
      args.to = raw;
    } else if (a === '--enable-mutations') {
      args.enableMutations = true;
    } else if (a === '--disable-mutations') {
      args.disableMutations = true;
    }
  }
  if (args.enableMutations && args.disableMutations) {
    console.error('Cannot --enable-mutations and --disable-mutations in the same invocation.');
    process.exit(2);
  }
  return args;
}

async function listCampaigns(): Promise<void> {
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      settings: campaigns.settings,
      lastPlayedAt: campaigns.lastPlayedAt,
    })
    .from(campaigns)
    .where(isNull(campaigns.deletedAt))
    .orderBy(sql`last_played_at DESC NULLS LAST`)
    .limit(50);

  if (rows.length === 0) {
    console.log('(no campaigns found)');
    return;
  }

  console.log('id (short)  backend  mut  last played       name');
  console.log('──────────  ───────  ───  ─────────────────  ────');
  for (const r of rows) {
    const shortId = r.id.slice(0, 8);
    const backend = resolveMasterBackend(r.settings.masterBackend);
    const mut = r.settings.vaultMutations === true ? 'on ' : 'off';
    const last = r.lastPlayedAt ? r.lastPlayedAt.toISOString().slice(0, 16).replace('T', ' ') : '—';
    const name = r.name.slice(0, 50);
    console.log(`${shortId}    ${backend.padEnd(7)}  ${mut}  ${last.padEnd(17)}  ${name}`);
  }
  console.log('');
  console.log('To flip one onto the vault backend:');
  console.log('  pnpm vault:flip --id=<short-or-full-uuid> --to=vault');
  console.log('To enable event-sourced mutations (Phase 02):');
  console.log('  pnpm vault:flip --id=<short-or-full-uuid> --enable-mutations');
}

async function resolveCampaignId(prefix: string): Promise<string | null> {
  // Allow either a full UUID or a short prefix (first 8 chars or any prefix).
  // If the prefix is 36 chars (full UUID format), look up exactly. Otherwise
  // pattern match.
  if (prefix.length === 36) {
    const [row] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, prefix))
      .limit(1);
    return row?.id ?? null;
  }

  // Postgres LIKE doesn't accept uuid operands → cast to text. drizzle's
  // `like(campaigns.id, ...)` would emit `id LIKE $1` which fails with
  // "operator does not exist: uuid ~~ unknown" on a uuid column. The
  // raw `sql` template lets us write the cast explicitly.
  const matches = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(sql`${campaigns.id}::text LIKE ${prefix + '%'}`)
    .limit(2);

  if (matches.length === 0) {
    console.error(`No campaign id starts with '${prefix}'. Run \`pnpm vault:flip\` (no args) to list.`);
    process.exit(2);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix '${prefix}' matches multiple campaigns. Use a longer prefix or the full UUID.`);
    process.exit(2);
  }
  return matches[0]!.id;
}

async function flipBackend(id: string, to: MasterBackend): Promise<{ id: string; name: string; settings: import('@/db/schema').CampaignSettings }> {
  const fullId = await resolveCampaignId(id);
  if (!fullId) {
    console.error(`Campaign ${id} not found.`);
    process.exit(2);
  }

  const [before] = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns)
    .where(eq(campaigns.id, fullId))
    .limit(1);
  if (!before) {
    console.error(`Campaign ${fullId} disappeared mid-flip.`);
    process.exit(2);
  }

  const prevBackend = resolveMasterBackend(before.settings.masterBackend);
  if (prevBackend === to) {
    console.log(`Campaign "${before.name}" (${fullId.slice(0, 8)}) is already on '${to}'. No-op.`);
    return before;
  }

  const nextSettings = { ...before.settings, masterBackend: to };
  await db
    .update(campaigns)
    .set({ settings: nextSettings, updatedAt: new Date() })
    .where(eq(campaigns.id, fullId));

  console.log(`✓ Campaign "${before.name}" (${fullId.slice(0, 8)}) flipped: ${prevBackend} → ${to}`);
  if (to === 'vault') {
    console.log('');
    console.log('  Next steps:');
    console.log('    pnpm migrate-handbook-to-vault   # if not already run');
    console.log('    pnpm dev                          # ensure dev server is up');
    console.log('    pnpm bench-vault-m4 --user-jwt=<__session-cookie>');
  }
  return { ...before, settings: nextSettings };
}

/**
 * Enable event-sourced mutations for a campaign: set `vaultMutations: true`
 * and append the synthetic `campaign_initialized` seed event sourced from
 * Postgres.
 *
 * The seed assembly is the load-bearing piece. Two non-obvious shapes:
 *
 *   1. `hp_current` lives on `session_state.hpCurrent` (per session, NOT
 *      per character). The query LEFT JOINs `sessions.campaignId =
 *      campaign.id` AND `sessions.characterId = characters.id`, then LEFT
 *      JOINs `session_state.sessionId = sessions.id`, then ORDER BY
 *      sessions.updatedAt DESC to put the most-recent active session row
 *      first per character. A JS-side dedup keeps the FIRST row per
 *      character id (most recent). When no session row exists, the LEFT
 *      JOIN leaves `ss.hpCurrent` null, and we OMIT `hp_current` from the
 *      seed — the projector falls back to `hp_max` (full HP).
 *
 *   2. `spell_slots` is assembled from `characters.spellcasting.slotsMax`
 *      (per-level cap, may be null for non-casters) merged with
 *      `characters.spellSlotsUsed` (per-level counter, defaults to {}).
 *      Non-casters and empty merged records produce no `spell_slots` key
 *      on the seed — the projector falls back to `{}`.
 */
async function enableMutations(
  campaign: { id: string; name: string; settings: import('@/db/schema').CampaignSettings },
): Promise<void> {
  const settings = campaign.settings;

  // Pitfall 5 warning: vaultMutations is a no-op unless masterBackend is also
  // 'vault'. We still flip the flag (storage is idempotent) and warn.
  if (settings.masterBackend !== 'vault') {
    console.warn(
      `[vault-flip] WARN: enabling vaultMutations on a baked campaign — flag has no effect until masterBackend is also set to vault (Pitfall 5).`,
    );
  }

  // 1. Persist settings.
  const nextSettings = { ...settings, vaultMutations: true };
  await db
    .update(campaigns)
    .set({ settings: nextSettings, updatedAt: new Date() })
    .where(eq(campaigns.id, campaign.id));

  // 2. Query characters with LEFT JOINs onto sessions + session_state.
  // Strategy: for each character that is currently tied to this campaign
  // (campaignId = campaign.id), find the MOST-RECENT session that uses
  // this character (sessions.characterId = characters.id), then LEFT JOIN
  // session_state on that session. ORDER BY sessions.updatedAt DESC keeps
  // the freshest row first; the JS-side Map dedup picks the FIRST per
  // character id, which is the most-recent (Map.set keeps the first
  // inserted-at-this-key value when used with `new Map(entries)`).
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      hpMax: characters.hpMax,
      spellcasting: characters.spellcasting,
      spellSlotsUsed: characters.spellSlotsUsed,
      hpCurrent: sessionState.hpCurrent, // nullable via LEFT JOIN
    })
    .from(characters)
    .leftJoin(
      sessions,
      and(eq(sessions.characterId, characters.id), eq(sessions.campaignId, campaign.id)),
    )
    .leftJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .where(eq(characters.campaignId, campaign.id))
    .orderBy(desc(sessions.updatedAt));

  // Dedup: keep ONE row per character (the most-recent one because of the
  // ORDER BY). `new Map(entries)` keeps the LAST set value for a key, so
  // we reverse the rows to ensure the FIRST (most-recent) wins after
  // dedup. Documented because drizzle does not yet expose `DISTINCT ON`.
  const dedupedRows = Array.from(
    new Map([...rows].reverse().map((r) => [r.id, r] as const)).values(),
  ).reverse(); // restore most-recent-first ordering for stable logs

  if (dedupedRows.length === 0) {
    console.log(
      `[vault-flip] WARN: no characters bound to campaign ${campaign.id.slice(0, 8)} — seed payload will be empty.`,
    );
  }

  // 3. Build seed payload.
  const payloadCharacters: VaultSeedCharacter[] = dedupedRows.map((r) => {
    const seed: VaultSeedCharacter = {
      id: r.id,
      name: r.name,
      hp_max: r.hpMax,
    };

    // hp_current: include ONLY when session_state row exists. Clamp
    // defensively to [0, hp_max] — guards against stale session_state
    // overshooting after a manual hp_max decrease (T-02-03 parallel).
    if (typeof r.hpCurrent === 'number' && Number.isInteger(r.hpCurrent)) {
      seed.hp_current = Math.max(0, Math.min(r.hpMax, r.hpCurrent));
    }

    // spell_slots: assemble from spellcasting.slotsMax + spellSlotsUsed.
    // Skip entirely if the PC is a non-caster (spellcasting null) or the
    // merged record is empty.
    if (r.spellcasting && r.spellcasting.slotsMax) {
      const slotsMax: Record<string, number> = r.spellcasting.slotsMax;
      const slotsUsed: Record<string, number> = r.spellSlotsUsed ?? {};
      const merged: Record<string, { max: number; used: number }> = {};
      for (const level of Object.keys(slotsMax)) {
        const max = slotsMax[level] ?? 0;
        if (max <= 0) continue;
        const used = Math.max(0, Math.min(max, slotsUsed[level] ?? 0));
        merged[level] = { max, used };
      }
      if (Object.keys(merged).length > 0) {
        seed.spell_slots = merged;
      }
    }

    return seed;
  });

  // 4. Construct envelope and append.
  const envelope: VaultEventEnvelope = {
    id: randomUUID(),
    version: EVENT_SCHEMA_VERSION,
    type: 'campaign_initialized',
    payload: { characters: payloadCharacters },
    timestamp: new Date().toISOString(),
  };

  // 5. Append via EventsWriter (single-writer mutex per absolute path).
  await EventsWriter.applyEvent(eventsPath(campaign.id), envelope);

  // 6. Regenerate views for every seeded character.
  await regenerateAffectedViews(campaign.id, envelope);

  // 7. Log.
  console.log(
    `[vault-flip] seeded campaign with ${payloadCharacters.length} characters; vault mutations enabled.`,
  );
  for (const c of payloadCharacters) {
    const hpNote =
      c.hp_current !== undefined
        ? `hp_current=${c.hp_current}`
        : `hp_current=hp_max(${c.hp_max}) (no session_state row)`;
    const slotsNote = c.spell_slots
      ? `${Object.keys(c.spell_slots).length} slot levels`
      : 'no spell slots';
    console.log(`[vault-flip]  - ${c.name} (${c.id.slice(0, 8)}): ${hpNote}, ${slotsNote}`);
  }
}

/**
 * Disable event-sourced mutations: set `vaultMutations: false`. Do NOT
 * delete events.md — the durable record stays for re-enablement.
 */
async function disableMutations(
  campaign: { id: string; name: string; settings: import('@/db/schema').CampaignSettings },
): Promise<void> {
  const nextSettings = { ...campaign.settings, vaultMutations: false };
  await db
    .update(campaigns)
    .set({ settings: nextSettings, updatedAt: new Date() })
    .where(eq(campaigns.id, campaign.id));
  console.log(
    `[vault-flip] disabled vaultMutations for "${campaign.name}" (${campaign.id.slice(0, 8)}). events.md preserved for re-enable.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // No flags at all → list mode.
  if (!args.id && !args.to && !args.enableMutations && !args.disableMutations) {
    await listCampaigns();
    await pool.end();
    process.exit(0);
  }

  // Mutation-only flags still require --id.
  if (!args.id) {
    console.error('--id=<uuid> is required when passing --to, --enable-mutations, or --disable-mutations.');
    console.error('Without args, lists all campaigns.');
    process.exit(2);
  }

  // Load the campaign once and thread through the flow.
  let campaign: { id: string; name: string; settings: import('@/db/schema').CampaignSettings };
  if (args.to) {
    // --to flips backend first; we get the post-flip row back.
    campaign = await flipBackend(args.id, args.to);
  } else {
    // No --to: just look up the campaign.
    const fullId = await resolveCampaignId(args.id);
    if (!fullId) {
      console.error(`Campaign ${args.id} not found.`);
      process.exit(2);
    }
    const [row] = await db
      .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
      .from(campaigns)
      .where(eq(campaigns.id, fullId))
      .limit(1);
    if (!row) {
      console.error(`Campaign ${fullId} disappeared.`);
      process.exit(2);
    }
    campaign = row;
  }

  if (args.enableMutations) {
    await enableMutations(campaign);
  } else if (args.disableMutations) {
    await disableMutations(campaign);
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('vault-flip failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
