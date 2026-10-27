import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { shouldIncludeCurrency } from '@/lib/currency-config';
import { ExchangeRateInsert, insertRates, insertScrapeLog, updateScrapeLog } from '@/lib/supabase';
import { generateRunId, getTodayDate } from '@/collectors/base';

const SCB_PROXY_URL =
    'https://realestate.mygreentownhousing.com/erp-aa/currency/fx/scb_proxy.aspx';

const SCB_CURRENCIES = [
    'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD', 'KRW', 'CHF', 'AUD', 'MYR',
    'ZAR', 'SEK', 'CAD', 'DKK', 'NOK', 'NZD', 'INR', 'CNY', 'PHP', 'TWD',
    'BHD', 'SAR', 'IDR', 'AED', 'OMR', 'BND', 'VND'
];

function parseNumber(val: unknown): number | undefined {
    if (val === null || val === undefined || val === '' || val === '-') {
        return undefined;
    }
    const num = Number(val);
    return isNaN(num) ? undefined : num;
}

function parseDivide(val: unknown, divisor: number): number | undefined {
    const num = parseNumber(val);
    if (num === undefined) return undefined;
    return divisor === 1 ? num : num / divisor;
}

function parseTimestamp(date: string, time: string): string {
    try {
        return new Date(`${date}T${time}+07:00`).toISOString();
    } catch {
        return new Date().toISOString();
    }
}

function processScbItems(items: any[], runId: string, rateDate: string): ExchangeRateInsert[] {
    const rates: ExchangeRateInsert[] = [];
    for (const item of items) {
        const currency = (item.curCode || '').toUpperCase();
        if (!currency || !SCB_CURRENCIES.includes(currency)) continue;
        if (!shouldIncludeCurrency('SCB', currency)) continue;

        const bankTimestamp = item.runDate && item.runTime
            ? parseTimestamp(item.runDate, item.runTime)
            : new Date().toISOString();

        const divisor = currency === 'JPY' ? 100 : 1;

        rates.push({
            run_id: runId,
            rate_date: rateDate,
            source: 'SCB',
            currency,
            currency_label: item.curName || currency,
            sell_tt: parseDivide(item.sellDD, divisor),
            sell_notes: parseDivide(item.sellNotes, divisor),
            buy_tt: parseDivide(item.buyTT, divisor),
            buy_sight: parseDivide(item.buyExport, divisor),
            buy_transfer: parseDivide(item.buyTCHQ, divisor),
            buy_notes: parseDivide(item.buyNotes, divisor),
            bank_timestamp: bankTimestamp,
            raw_data: item,
        });
    }
    return rates;
}

// GET: Test reaching Mango Proxy from Vercel & fetch rates
export async function GET() {
    const startMs = Date.now();
    try {
        const res = await axios.get(SCB_PROXY_URL, {
            headers: { Accept: 'application/json' },
            timeout: 15000,
        });
        const items = res.data?.exchangeRates || [];
        return NextResponse.json({
            success: true,
            server: 'Vercel',
            proxyUrl: SCB_PROXY_URL,
            durationMs: Date.now() - startMs,
            recordsFound: items.length,
            sample: items[0] || null,
        });
    } catch (err: any) {
        return NextResponse.json({
            success: false,
            error: err.message,
            code: err.code,
            status: err.response?.status,
            data: err.response?.data,
            durationMs: Date.now() - startMs,
        }, { status: 500 });
    }
}

// POST: Accept SCB JSON from Google Apps Script (or trigger fetch from Mango proxy)
export async function POST(request: NextRequest) {
    const startMs = Date.now();
    const runId = generateRunId();
    const rateDate = getTodayDate();
    let logId: number | null = null;

    try {
        const log = await insertScrapeLog({
            run_id: runId,
            source: 'SCB',
            status: 'running',
        });
        logId = log?.id ?? null;
    } catch (logErr) {
        console.error('Failed to insert scrape log:', logErr);
    }

    try {
        let items: any[] = [];
        let body: any = null;
        try {
            body = await request.json();
        } catch {
            body = null;
        }

        // If body has exchangeRates, use them directly (pushed from GAS)
        if (body && Array.isArray(body.exchangeRates)) {
            items = body.exchangeRates;
            console.log(`[SCB Sync] Received ${items.length} rates directly from caller`);
        } else {
            // Otherwise fetch from Mango Proxy
            console.log(`[SCB Sync] Fetching from Mango proxy: ${SCB_PROXY_URL}`);
            const res = await axios.get(SCB_PROXY_URL, {
                headers: { Accept: 'application/json' },
                timeout: 20000,
            });
            items = res.data?.exchangeRates || [];
        }

        if (items.length === 0) {
            throw new Error('No exchangeRates found in payload or proxy response');
        }

        const rates = processScbItems(items, runId, rateDate);
        if (rates.length === 0) {
            throw new Error('0 valid SCB rates after currency filter');
        }

        await insertRates(rates);

        const durationMs = Date.now() - startMs;
        if (logId) {
            await updateScrapeLog(logId, {
                status: 'success',
                completed_at: new Date().toISOString(),
                records_count: rates.length,
                duration_ms: durationMs,
            });
        }

        return NextResponse.json({
            success: true,
            source: 'SCB',
            rateDate,
            recordsCount: rates.length,
            durationMs,
        });
    } catch (err: any) {
        const durationMs = Date.now() - startMs;
        const errMsg = err.message || String(err);
        if (logId) {
            await updateScrapeLog(logId, {
                status: 'failed',
                error_message: errMsg,
                completed_at: new Date().toISOString(),
                duration_ms: durationMs,
            });
        }
        return NextResponse.json({
            success: false,
            error: errMsg,
            durationMs,
        }, { status: 500 });
    }
}
