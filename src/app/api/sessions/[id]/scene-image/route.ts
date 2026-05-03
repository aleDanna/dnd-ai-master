import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, sessionState } from '@/db/schema';

export async function GET(req: NextRequest | Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthenticated', { status: 401 });
  const { id: sessionId } = await params;

  // Ownership check + state read in one round-trip.
  const [row] = await db
    .select({
      version: sessionState.sceneImageVersion,
      data: sessionState.sceneImageData,
    })
    .from(sessions)
    .innerJoin(sessionState, eq(sessionState.sessionId, sessions.id))
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
    .limit(1);

  if (!row || row.version === 0 || !row.data) {
    return new Response('not-found', { status: 404 });
  }

  const etag = `"v${row.version}"`;
  const ifNoneMatch = req.headers.get('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // Wrap the Node Buffer in a Uint8Array view: Next 16's App Router runs on
  // Web-Fetch primitives whose Response constructor accepts Uint8Array but
  // not Node Buffer directly. The view is zero-copy.
  return new Response(Buffer.isBuffer(row.data) ? new Uint8Array(row.data) : row.data, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      ETag: etag,
    },
  });
}
