#!/usr/bin/env tsx
/**
 * scripts/vault-rebuild-views.ts — recovery script: regenerate every
 * materialized character view from events.md by replaying the event log.
 *
 * REQ-006 — events.md is the only durable artifact; materialized character
 *           views (under `<campaign>/characters/`) are pure projections.
 *           Recovery procedure is: take backup → replay events.md →
 *           regenerate views (spike 013 byte-exact validation).
 *
 * Spike 013 §"Signal for the real build" mandates this script ships as
 * the only-supported recovery mechanism (do NOT let users hand-edit
 * derived views; treat them as ephemeral).
 *
 * Usage:
 *   pnpm vault:rebuild-views                         # rebuild every campaign under VAULT_CAMPAIGNS_ROOT
 *   pnpm vault:rebuild-views --campaign=<uuid>       # rebuild ONE campaign
 *
 * Use cases:
 *   (a) A view file was accidentally edited and operator wants byte-exact
 *       restoration.
 *   (b) The projector code changed (new field, new emit order) and existing
 *       views need re-derivation to match the new format.
 *   (c) A new schema field was added (Phase 03+) and old campaigns need
 *       backfill — same procedure: replay events.md, regenerate.
 *
 * Per-campaign flow:
 *   1. Validate UUID syntax via UUID_REGEX (T-02-04 defense — campaignId
 *      from the CLI is operator-supplied, treat as untrusted).
 *   2. Parse events.md (or skip if missing — fresh campaign before any
 *      apply_event).
 *   3. Replay → Map<characterId, CharacterState>.
 *   4. For each character in the replayed state Map, call
 *      regenerateCharacterView (mkdir -p + writeFile is internal).
 *
 * Multi-campaign flow:
 *   - readdirSync(VAULT_CAMPAIGNS_ROOT) → filter entries that (a) match
 *     UUID_REGEX and (b) are directories.
 *   - Run the per-campaign flow for each.
 *
 * No DB access. No env requirement beyond VAULT_CAMPAIGNS_ROOT (which has
 * a homedir default — see src/ai/master/vault/path.ts).
 */
import './_env-loader';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_CAMPAIGNS_ROOT } from '@/ai/master/vault/path';
import { eventsPath, UUID_REGEX } from '@/ai/master/vault/campaign-paths';
import {
  parseEventsFile,
  regenerateCharacterView,
  replayEvents,
} from '@/ai/master/vault/projector';

interface Args {
  campaign: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { campaign: null };
  for (const a of argv) {
    if (a.startsWith('--campaign=')) {
      args.campaign = a.slice('--campaign='.length);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage:');
      console.log('  pnpm vault:rebuild-views                       # rebuild every campaign');
      console.log('  pnpm vault:rebuild-views --campaign=<uuid>     # rebuild ONE campaign');
      process.exit(0);
    }
  }
  return args;
}

/**
 * Rebuild every character view for one campaign. No-op when the
 * campaign's events.md does not exist (a freshly-created campaign that
 * has never had apply_event called).
 */
async function rebuildOneCampaign(campaignId: string): Promise<void> {
  if (!UUID_REGEX.test(campaignId)) {
    console.error(`[rebuild] invalid UUID: ${campaignId}`);
    process.exit(2);
  }
  const path = eventsPath(campaignId);
  if (!existsSync(path)) {
    console.log(`[rebuild] no events.md for ${campaignId}; skipping`);
    return;
  }

  const envelopes = await parseEventsFile(path);
  const { chars: states } = replayEvents(envelopes);
  console.log(
    `[rebuild] ${campaignId}: ${envelopes.length} events → ${states.size} characters`,
  );
  for (const charId of states.keys()) {
    await regenerateCharacterView(campaignId, charId);
    console.log(`[rebuild] ${campaignId}: regenerated view for character ${charId}`);
  }
}

/**
 * Multi-campaign mode: list immediate children of VAULT_CAMPAIGNS_ROOT,
 * keep those whose name matches UUID_REGEX and that are directories,
 * then rebuild each one. Other entries (e.g. .git/, .gitignore, README)
 * are silently skipped — the filter is the safety net.
 */
async function rebuildAllCampaigns(): Promise<void> {
  if (!existsSync(VAULT_CAMPAIGNS_ROOT)) {
    console.log(`[rebuild] VAULT_CAMPAIGNS_ROOT does not exist: ${VAULT_CAMPAIGNS_ROOT}`);
    console.log('[rebuild] nothing to rebuild.');
    return;
  }
  const entries = readdirSync(VAULT_CAMPAIGNS_ROOT);
  const campaignIds = entries.filter((name) => {
    if (!UUID_REGEX.test(name)) return false;
    try {
      return statSync(join(VAULT_CAMPAIGNS_ROOT, name)).isDirectory();
    } catch {
      return false;
    }
  });

  if (campaignIds.length === 0) {
    console.log('[rebuild] no campaign directories found.');
    return;
  }

  console.log(`[rebuild] found ${campaignIds.length} campaign(s) under ${VAULT_CAMPAIGNS_ROOT}`);
  for (const id of campaignIds) {
    await rebuildOneCampaign(id);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.campaign) {
    await rebuildOneCampaign(args.campaign);
  } else {
    await rebuildAllCampaigns();
  }
}

main().catch((err) => {
  console.error('vault-rebuild-views failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
