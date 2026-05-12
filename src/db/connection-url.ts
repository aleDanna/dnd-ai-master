import { config as loadEnv } from 'dotenv';

/**
 * Load DB env vars from the standard precedence chain.
 *
 *   .env.development.local  (highest — used to point dev at a local Postgres)
 *   .env.local              (Vercel-pulled secrets, typically Neon)
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
 * - For local hosts: default to `sslmode=disable` if not specified (local PG usually has no SSL).
 * - For remote hosts (Neon, RDS, etc.): force `sslmode=verify-full` unless the user picked a
 *   stricter value. This preserves the strict cert verification behavior the project relies on
 *   while staying portable to local containers.
 *
 * pg-connection-string v3 / pg v9 will change defaults; locking this explicitly keeps behavior
 * stable through that transition.
 */
export function normalizeSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const current = parsed.searchParams.get('sslmode');
    if (LOCAL_HOSTS.has(host)) {
      if (!current) parsed.searchParams.set('sslmode', 'disable');
      return parsed.toString();
    }
    if (!current || ['prefer', 'require', 'verify-ca'].includes(current)) {
      parsed.searchParams.set('sslmode', 'verify-full');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
