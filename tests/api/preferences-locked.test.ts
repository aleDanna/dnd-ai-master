import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users } from '@/db/schema';
import { NextRequest } from 'next/server';

const USER = 'user_prefs_locked_' + Date.now();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: USER })),
}));

import { PUT } from '@/app/api/preferences/route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/preferences', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('PUT /api/preferences — locked down to ttsAutoplay', () => {
  beforeEach(async () => {
    await db.insert(users).values({ id: USER, displayName: 'U', preferences: {} }).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${USER}`);
    await pool.end();
  });

  it('accepts a ttsAutoplay-only patch', async () => {
    const res = await PUT(makeReq({ ttsAutoplay: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preferences.ttsAutoplay).toBe(true);
  });

  it('rejects any other key with 400 unknown-key', async () => {
    const res = await PUT(makeReq({ aiProvider: 'openai' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown-key');
  });

  it('rejects non-boolean ttsAutoplay', async () => {
    const res = await PUT(makeReq({ ttsAutoplay: 'yes' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-ttsAutoplay');
  });
});
