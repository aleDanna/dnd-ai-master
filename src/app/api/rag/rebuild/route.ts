import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { rebuildIndex } from '@/ai/master/rag/indexer';
import { getRagStore } from '@/ai/master/rag/store';
import { embed } from '@/ai/master/rag/embedder';
import { getMasterHandbook, getMasterWorldLore } from '@/ai/master/handbook';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rag/rebuild - triggers a fresh index build. Requires auth.
 * Optional body: { force?: boolean }.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { force?: boolean };
  const handbookMd = getMasterHandbook();
  const loreMd = getMasterWorldLore();
  const { store, backend } = await getRagStore();
  const result = await rebuildIndex({
    handbookMd,
    loreMd,
    store,
    embedFn: (t) => embed(t),
    force: !!body.force,
  });
  return NextResponse.json({ ...result, backend });
}
