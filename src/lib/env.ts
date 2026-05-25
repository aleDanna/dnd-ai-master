/**
 * Defensive parsing for env-configured values.
 *
 * `vercel env pull` writes sensitive secrets as empty strings (e.g. `FOO=""`)
 * so local .env files don't leak production values. The naive pattern
 * `Number(process.env.FOO ?? '200')` does NOT catch this: nullish coalescing
 * only fires for `undefined`/`null`, not `""`, so `Number("")` silently
 * becomes `0`. Any consumer that treats 0 as "limit hit" or "disabled" then
 * silently breaks in prod.
 *
 * These helpers treat empty/whitespace/garbage as "unset" and fall back.
 * Zero is preserved as a valid explicit value (e.g. "disable cap").
 */

function rawValue(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function envInt(name: string, fallback: number): number {
  const raw = rawValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

export function envPositiveInt(name: string, fallback: number): number {
  const n = envInt(name, fallback);
  return n >= 0 ? n : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = rawValue(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}
