import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const SCB_URL =
    'https://www.scb.co.th/services/scb/exchangeRateService/latest.json?_charset_=UTF-8&lang=en&page=2ea9c13a-6fb9-4a75-9abd-87ef79ee71cc%2C907ab931-1989-41b4-b599-10bff5593570';

/**
 * SCB JSON fields mapping:
 *   curCode    → currency
 *   curName    → currency_label
 *   sellDD     → sell_tt
 *   sellNotes  → sell_notes
 *   buyTT      → buy_tt
 *   buyExport  → buy_sight
 *   buyTCHQ    → buy_transfer
 *   buyNotes   → buy_notes
 *   runDate/runTime → bank_timestamp
 */
export class ScbCollector implements Collector {
    name = 'SCB';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const { data } = await axios.get(SCB_URL, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
            timeout: 30000,
        });

        const rates: ExchangeRateInsert[] = [];
        const items: ScbRate[] = data.exchangeRates || [];

        for (const item of items) {
            const currency = (item.curCode || '').toUpperCase();
            if (!currency) continue;
            if (!shouldIncludeCurrency(this.name, currency)) continue;

            const bankTimestamp = item.runDate && item.runTime
                ? this.parseTimestamp(item.runDate, item.runTime)
                : new Date().toISOString();

            // SCB reports JPY per 100 yen — normalize to per 1 yen to match other sources
            const divisor = currency === 'JPY' ? 100 : 1;

            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency,
                currency_label: item.curName || currency,
                sell_tt: this.parseDivide(item.sellDD, divisor),
                sell_notes: this.parseDivide(item.sellNotes, divisor),
                buy_tt: this.parseDivide(item.buyTT, divisor),
                buy_sight: this.parseDivide(item.buyExport, divisor),
                buy_transfer: this.parseDivide(item.buyTCHQ, divisor),
                buy_notes: this.parseDivide(item.buyNotes, divisor),
                bank_timestamp: bankTimestamp,
                raw_data: item as unknown as Record<string, unknown>,
            });
        }

        return { rates, rateDate };
    }

    private parseTimestamp(date: string, time: string): string {
        // date: "2026-02-19", time: "13:34:05"
        try {
            return new Date(`${date}T${time}+07:00`).toISOString();
        } catch {
            return new Date().toISOString();
        }
    }

    private parseNumber(val: unknown): number | undefined {
        if (val === null || val === undefined || val === '' || val === '-') {
            return undefined;
        }
        const num = Number(val);
        return isNaN(num) ? undefined : num;
    }

    private parseDivide(val: unknown, divisor: number): number | undefined {
        const num = this.parseNumber(val);
        if (num === undefined) return undefined;
        return divisor === 1 ? num : num / divisor;
    }
}

interface ScbRate {
    curCode: string;
    curName: string;
    sellDD: string;
    sellNotes: string;
    buyTT: string;
    buyExport: string;
    buyTCHQ: string;
    buyNotes: string;
    runDate: string;
    runTime: string;
    recNo: string;
}
