import { config as loadEnv } from 'dotenv';

/**
 * Load DB env vars from the standard precedence chain.
 *
 *   .env.development.local  (highest — used to point dev at a local Postgres)
 *   .env.local              (Vercel-pulled secrets, typically Supabase)
 *   .env                    (fallback)
 *
 * dotenv is first-write-wins by default, so the order matters.
 */
export function loadDbEnv(): void {
  loadEnv({ path: '.env.development.local' });
  loadEnv({ path: '.env.local' });
  loadEnv();
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

/**
 * Normalize sslmode in a Postgres connection string.
 *
 * - For local hosts: default to `sslmode=disable` if not specified.
 * - For remote hosts: require SSL with libpq compat. `uselibpqcompat=true` tells pg v9 to
 *   match libpq's historical `sslmode=require` semantics (encrypted but no cert chain
 *   validation). Supabase pooler's cert chain is not in Node's default trust store, so
 *   strict validation fails. TODO: bundle Supabase CA bundle and switch to verify-full.
 */
export function normalizeSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (LOCAL_HOSTS.has(host)) {
      if (!parsed.searchParams.get('sslmode')) {
        parsed.searchParams.set('sslmode', 'disable');
      }
      return parsed.toString();
    }
    if (!parsed.searchParams.get('sslmode')) {
      parsed.searchParams.set('sslmode', 'require');
    }
    if (!parsed.searchParams.get('uselibpqcompat')) {
      parsed.searchParams.set('uselibpqcompat', 'true');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
