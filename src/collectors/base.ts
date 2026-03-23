import { ExchangeRateInsert } from '../lib/supabase';

/**
 * Base collector interface — all sources implement this
 */
export interface CollectorResult {
    rates: ExchangeRateInsert[];
    rateDate: string;
    bankTimestamp?: string;
    rawResponse?: any;
}

export interface Collector {
    name: string;
    fetch(): Promise<CollectorResult>;
}

/**
 * Get today's date in YYYY-MM-DD format (Thailand timezone)
 */
export function getTodayDate(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

/**
 * Get yesterday's business date (skip weekends)
 */
export function getPreviousBusinessDate(): string {
    const now = new Date();
    const thai = new Date(
        now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
    );

    // Go back 1 day
    thai.setDate(thai.getDate() - 1);

    // Skip weekends (0=Sun, 6=Sat)
    while (thai.getDay() === 0 || thai.getDay() === 6) {
        thai.setDate(thai.getDate() - 1);
    }

    return thai.toISOString().split('T')[0];
}

/**
 * Get yesterday's date (calendar day, no weekend skip)
 * Used by Bloomberg for BTN/MNT which always use yesterday's rate
 */
export function getYesterdayDate(): string {
    const now = new Date();
    const thai = new Date(
        now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
    );
    thai.setDate(thai.getDate() - 1);
    return thai.toISOString().split('T')[0];
}

/**
 * Generate a UUID v4
 */
export function generateRunId(): string {
    return crypto.randomUUID();
}
