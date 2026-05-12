import { NextResponse } from 'next/server';

const GONE_BODY = {
  error: 'endpoint-removed',
  message: 'Sessions are now created via POST /api/campaigns. List sessions via GET /api/campaigns and campaign detail.',
};

export function GET() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}

export function POST() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}
