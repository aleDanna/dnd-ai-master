import { type VercelConfig } from '@vercel/config/v1';

/**
 * The Vercel project was created with framework preset "Other", which made Vercel
 * treat the deploy as a static site (looking for files in `public/`) and ignore the
 * Next.js routing. Result: every route returned 404 in production. Declaring
 * `framework: 'nextjs'` here pins it correctly so Next's router, middleware (proxy.ts),
 * and serverless functions all wire up.
 *
 * `buildCommand` runs Drizzle migrations before `next build`. Vercel exposes the
 * production env vars during the build step, so `pnpm db:migrate` has the right
 * DATABASE_URL to apply any pending SQL in `drizzle/` to Supabase. Without this,
 * a deploy that introduced a new schema column would ship code that immediately
 * 500s every read against the table — which is exactly how we got bitten by the
 * `campaigns.settings`, `characters.spell_slots_used`, etc. drift.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'pnpm db:migrate && next build',
};
