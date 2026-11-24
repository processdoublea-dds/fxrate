import { NextResponse } from 'next/server';
import { runKbankShadowTest } from '@/lib/kbank-shadow';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    return handleShadowTest(request);
}

export async function POST(request: Request) {
    return handleShadowTest(request);
}

async function handleShadowTest(request: Request) {
    const url = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    const secretQuery = url.searchParams.get('secret') || url.searchParams.get('key');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret) {
        const isAuthHeaderValid = authHeader === `Bearer ${cronSecret}`;
        const isQueryValid = secretQuery === cronSecret;
        if (!isAuthHeaderValid && !isQueryValid) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    const force = url.searchParams.get('force') === 'true';
    const result = await runKbankShadowTest({ force });
    return NextResponse.json(result.body, { status: result.httpStatus });
}
