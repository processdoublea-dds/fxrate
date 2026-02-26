import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Server-side client with service role key (bypasses RLS)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Check if rate already exists for given date + source AND the bank_timestamp matches the requested date
export async function hasRateForToday(source: string, rateDate: string): Promise<boolean> {
    const { data } = await supabaseAdmin
        .from('exchange_rates')
        .select('bank_timestamp')
        .eq('source', source)
        .eq('rate_date', rateDate)
        .limit(1);

    if (!data || data.length === 0) return false;

    // Check if the timestamp actually indicates an update for today
    const ts = data[0].bank_timestamp;
    if (!ts) return false;

    // Convert bank_timestamp to Thai local string YYYY-MM-DD
    const thaiDatestr = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

    // If the bank's own timestamp is still stuck on a previous date, we shouldn't consider it "fetched for today"
    return thaiDatestr === rateDate;
}

// Insert exchange rates (dedup by rate_date+source+currency to avoid ON CONFLICT error)
export async function insertRates(rates: ExchangeRateInsert[]) {
    // Dedup: keep last occurrence per (rate_date, source, currency)
    const seen = new Map<string, ExchangeRateInsert>();
    for (const r of rates) {
        const key = `${r.rate_date}|${r.source}|${r.currency}`;
        seen.set(key, r);
    }
    const deduped = Array.from(seen.values());

    const { data, error } = await supabaseAdmin
        .from('exchange_rates')
        .upsert(deduped, { onConflict: 'rate_date,source,currency' });

    if (error) throw new Error(`Insert rates failed: ${error.message}`);
    return data;
}

// Insert scrape log
export async function insertScrapeLog(log: ScrapeLogInsert) {
    const { data, error } = await supabaseAdmin
        .from('scrape_logs')
        .insert(log)
        .select()
        .single();

    if (error) throw new Error(`Insert scrape log failed: ${error.message}`);
    return data;
}

// Update scrape log on completion
export async function updateScrapeLog(
    id: number,
    update: Partial<ScrapeLogInsert>
) {
    const { error } = await supabaseAdmin
        .from('scrape_logs')
        .update(update)
        .eq('id', id);

    if (error) throw new Error(`Update scrape log failed: ${error.message}`);
}

// Delete old scrape logs
export async function deleteOldScrapeLogs(daysToKeep: number = 60) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const { count, error } = await supabaseAdmin
        .from('scrape_logs')
        .delete({ count: 'exact' })
        .lt('started_at', cutoffDate.toISOString());

    if (error) {
        console.error(`Failed to delete old scrape logs:`, error);
        return 0;
    }
    return count ?? 0;
}

// Types
export interface ExchangeRateInsert {
    run_id: string;
    rate_date: string;
    source: string;
    currency: string;
    currency_label?: string;
    sell_tt?: number;
    sell_notes?: number;
    buy_tt?: number;
    buy_sight?: number;
    buy_transfer?: number;
    buy_notes?: number;
    mid_rate?: number;
    bank_timestamp?: string;
    raw_data?: Record<string, unknown>;
}

export interface ScrapeLogInsert {
    run_id: string;
    source: string;
    status: 'success' | 'failed' | 'partial' | 'running';
    started_at?: string;
    completed_at?: string;
    records_count?: number;
    error_message?: string;
    duration_ms?: number;
}
