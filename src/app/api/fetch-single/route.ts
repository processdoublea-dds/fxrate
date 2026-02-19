import { NextRequest, NextResponse } from 'next/server';
import { BotCollector } from '@/collectors/bot';
import { ScbCollector } from '@/collectors/scb';
import { KtbCollector } from '@/collectors/ktb';
import { KbankCollector } from '@/collectors/kbank';
import { BloombergCollector } from '@/collectors/bloomberg';
import { insertRates, insertScrapeLog, updateScrapeLog } from '@/lib/supabase';
import { generateRunId } from '@/collectors/base';

const collectors: Record<string, { new(): { name: string; fetch: () => Promise<{ rates: unknown[]; rateDate: string }> } }> = {
    BOT: BotCollector,
    SCB: ScbCollector,
    KTB: KtbCollector,
    KBANK: KbankCollector,
    BLOOMBERG: BloombergCollector,
};

export async function POST(request: NextRequest) {
    const body = await request.json();
    const sourceName = (body.source || '').toUpperCase();

    if (!collectors[sourceName]) {
        return NextResponse.json(
            { error: `Unknown source: ${sourceName}. Valid: ${Object.keys(collectors).join(', ')}` },
            { status: 400 }
        );
    }

    const runId = generateRunId();
    const startTime = Date.now();

    const logId = await insertScrapeLog({
        run_id: runId,
        source: sourceName,
        status: 'running',
    });

    try {
        const CollectorClass = collectors[sourceName];
        const collector = new CollectorClass();
        const result = await collector.fetch();

        const rates = result.rates as Parameters<typeof insertRates>[0];
        let recordsCount = 0;

        if (rates.length > 0) {
            await insertRates(rates);
            recordsCount = rates.length;
        }

        const durationMs = Date.now() - startTime;

        if (logId) {
            await updateScrapeLog(logId, {
                status: recordsCount > 0 ? 'success' : 'partial',
                records_count: recordsCount,
                duration_ms: durationMs,
            });
        }

        return NextResponse.json({
            success: true,
            source: sourceName,
            recordsCount,
            durationMs,
        });
    } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (logId) {
            await updateScrapeLog(logId, {
                status: 'failed',
                error_message: errorMessage,
                duration_ms: durationMs,
            });
        }

        return NextResponse.json({
            success: false,
            source: sourceName,
            error: errorMessage,
            durationMs,
        }, { status: 500 });
    }
}
