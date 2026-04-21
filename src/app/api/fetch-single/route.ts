import { NextRequest, NextResponse } from 'next/server';
import { BotCollector } from '@/collectors/bot';
import { ScbCollector } from '@/collectors/scb';
import { KtbCollector } from '@/collectors/ktb';
import { KbankCollector } from '@/collectors/kbank';
import { BloombergCollector } from '@/collectors/bloomberg';
import { insertRates, insertScrapeLog, updateScrapeLog } from '@/lib/supabase';
import { generateRunId } from '@/collectors/base';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectors: Record<string, { new(): { name: string; fetch: () => Promise<{ rates: any[]; rateDate: string }> } }> = {
    BOT: BotCollector,
    SCB: ScbCollector,
    KTB: KtbCollector,
    KBANK: KbankCollector,
    BLOOMBERG: BloombergCollector,
};

export async function POST(request: NextRequest) {
    try {
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

        // Insert scrape log (non-blocking)
        let logId: number | null = null;
        try {
            const log = await insertScrapeLog({
                run_id: runId,
                source: sourceName,
                status: 'running',
            });
            logId = log?.id ?? null;
        } catch (logErr) {
            console.error('Failed to insert scrape log:', logErr);
        }

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

        const EXPECTED_COUNTS: Record<string, number> = {
            SCB: 27,
            KTB: 22,
            KBANK: 26,
            BOT: 23,
            BLOOMBERG: 2,
        };

        if (logId) {
            try {
                let finalStatus: 'success' | 'partial' | 'failed' = 'success';
                if (recordsCount === 0) {
                    finalStatus = 'failed';
                } else if (EXPECTED_COUNTS[sourceName] && recordsCount < EXPECTED_COUNTS[sourceName]) {
                    finalStatus = 'partial';
                }

                await updateScrapeLog(logId, {
                    status: finalStatus,
                    records_count: recordsCount,
                    duration_ms: durationMs,
                });
            } catch (logErr) {
                console.error('Failed to update scrape log:', logErr);
            }
        }

        return NextResponse.json({
            success: true,
            source: sourceName,
            recordsCount,
            durationMs,
        });
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('Fetch single error:', errorMessage);

        return NextResponse.json({
            success: false,
            error: errorMessage,
        }, { status: 500 });
    }
}
