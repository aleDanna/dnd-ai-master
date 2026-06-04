import { loadDbEnv, normalizeSslMode } from './connection-url';
loadDbEnv();

import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

declare global {
  var __dnd_pg_pool: Pool | undefined;
}

const pool =
  globalThis.__dnd_pg_pool ??
  new Pool({ connectionString: normalizeSslMode(connectionString), max: 10, idleTimeoutMillis: 30_000 });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__dnd_pg_pool = pool;
}

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { pool };

/**
 * Open a fresh, dedicated client for `LISTEN/NOTIFY`.
 *
 * Why a separate connection: `DATABASE_URL` is the Supabase **transaction
 * pooler** (Supavisor, port 6543), which does **not** support `LISTEN` — the
 * pooler hands the connection back between statements, so notifications fired
 * against the underlying session never reach the LISTEN-er.
 *
 * `DATABASE_URL_UNPOOLED` points at the Supabase **session pooler** (port 5432)
 * which keeps a connection bound to one underlying session for its lifetime,
 * making it safe for `LISTEN`. Locally `pnpm db:up` is a single Postgres so
 * the regular URL works fine — we fall back to `DATABASE_URL` when the
 * unpooled var is absent.
 *
 * The caller MUST `client.release()` (or `client.end()`) on stream abort to
 * avoid leaking sockets — we do that in `/api/sessions/[id]/stream`.
 */
export function createListenClient(): Client {
  const direct = process.env.DATABASE_URL_UNPOOLED?.trim();
  const url = direct && direct.length > 0 ? direct : connectionString;
  // We use a dedicated `Client` here rather than a `Pool.connect()` so we own
  // the connection lifecycle end-to-end — no `idleTimeoutMillis` reclamation
  // can drop it out from under an open SSE stream.
  return new Client({ connectionString: normalizeSslMode(url!) });
}

/**
 * Dedicated pool for SENDING `NOTIFY` (used by `notifySession`). It MUST use a
 * LISTEN/NOTIFY-capable connection for the SAME reason as `createListenClient`:
 * the transaction pooler (`DATABASE_URL`, port 6543) does NOT deliver
 * `pg_notify` to LISTEN-ers. Verified 2026-06-04: a notify sent THROUGH the 6543
 * pooler never reaches a 5432 LISTEN session, while a notify on a 5432 session
 * does. So the SSE live-update path needs the unpooled connection on BOTH ends —
 * LISTEN (createListenClient) AND NOTIFY (here). Falls back to the regular URL
 * for single-Postgres local setups, which deliver fine.
 */
declare global {
  // eslint-disable-next-line no-var
  var __dnd_notify_pool: Pool | undefined;
}
const notifyConnectionString = process.env.DATABASE_URL_UNPOOLED?.trim() || connectionString;
const notifyPool =
  globalThis.__dnd_notify_pool ??
  new Pool({ connectionString: normalizeSslMode(notifyConnectionString!), max: 4, idleTimeoutMillis: 30_000 });
if (process.env.NODE_ENV !== 'production') {
  globalThis.__dnd_notify_pool = notifyPool;
}
export { notifyPool };
