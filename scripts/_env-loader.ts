/**
 * Side-effect env loader for standalone scripts.
 *
 * The Vercel CLI on this project writes `.env.local` with EMPTY-string
 * placeholders for every secret (e.g. `DATABASE_URL=""`), and the real
 * values land in `.env.production.local`. tsx auto-loads `.env.local`
 * before any user code runs, so by the time our static imports execute,
 * `process.env.DATABASE_URL` is already `""` (empty, not undefined) —
 * which `@/db/client`'s `if (!url) throw` rejects.
 *
 * We must therefore EXPLICITLY load `.env.production.local` with
 * `override: true` so its real values overwrite tsx's empty placeholders.
 * Subsequent loads of `.env.local` / `.env` use `override: false` so
 * production secrets retain priority for any var also defined there.
 *
 * Import this FIRST in any script that touches `@/db/client`:
 *
 *   import './_env-loader';
 *   import { db } from '@/db/client';
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

const ROOT = process.cwd();
loadDotenv({ path: resolve(ROOT, '.env.production.local'), override: true });
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
      'DATABASE_URL is empty after loading .env.production.local + .env.local + .env.',
      'This project is linked to Vercel — the real value lives there.',
      '',
      'Fix it once with:',
      '  vercel env pull .env.production.local --environment=production',
      '',
      "Or, for the dev DB:",
      '  vercel env pull .env.development.local --environment=development',
      '',
      "Or, ad-hoc for a single run:",
      "  DATABASE_URL='postgres://...' pnpm <script>",
      '',
    ].join('\n'),
  );
  process.exit(2);
}
