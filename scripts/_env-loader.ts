/**
 * Side-effect env loader for standalone scripts.
 *
 * Project env file convention (per Vercel + Next.js):
 *   - `.env.local`            — loaded by BOTH `pnpm dev` (Next.js) AND tsx
 *                                scripts. This is where secrets should live
 *                                so the same value works in both worlds.
 *   - `.env.production.local` — loaded by Next.js production builds AND tsx
 *                                (via this loader). Vercel CLI writes
 *                                placeholders here when the secret is
 *                                marked "sensitive" — values are typically
 *                                empty unless manually populated.
 *   - `.env`                  — defaults (rarely populated in this project).
 *
 * Load order below mirrors Vercel's: production-local first (would win in
 * a prod build), then local, then defaults. `override: false` on all reads
 * means tsx's prior auto-load of `.env.local` is preserved when a key is
 * already in `process.env`.
 *
 * Import this FIRST in any script that touches `@/db/client`:
 *
 *   import './_env-loader';
 *   import { db } from '@/db/client';
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

const ROOT = process.cwd();
loadDotenv({ path: resolve(ROOT, '.env.production.local'), override: false });
loadDotenv({ path: resolve(ROOT, '.env.local'), override: false });
loadDotenv({ path: resolve(ROOT, '.env'), override: false });

// Friendly preflight: if DATABASE_URL is still missing or empty after
// loading every env file the project ships with, this project is linked
// to Vercel and the real secret lives in the Vercel platform — `pnpm dev`
// picks it up through Next.js + Vercel CLI integration, but standalone
// scripts (`tsx`) don't run that integration. Tell the developer exactly
// how to fix it.
if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      'DATABASE_URL is empty after loading .env.local + .env.production.local + .env.',
      'This project is linked to Vercel and DATABASE_URL is marked "sensitive" —',
      '`vercel env pull` leaves it empty.',
      '',
      'Fix once: copy the real value from the Vercel dashboard',
      '  (Settings → Environment Variables → DATABASE_URL → reveal → copy)',
      'and paste into .env.local (this single file works for BOTH',
      '`pnpm dev` and standalone scripts):',
      '',
      '  echo "DATABASE_URL=postgres://..." >> .env.local',
      '',
      'Ad-hoc for a single run:',
      "  DATABASE_URL='postgres://...' pnpm <script>",
      '',
    ].join('\n'),
  );
  process.exit(2);
}
