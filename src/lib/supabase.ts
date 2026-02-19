import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Server-side client with service role key (bypasses RLS)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Check if rate already exists for given date + source
export async function hasRateForToday(source: string, rateDate: string): Promise<boolean> {
    const { data } = await supabaseAdmin
        .from('exchange_rates')
        .select('id')
        .eq('source', source)
        .eq('rate_date', rateDate)
        .limit(1);

    return (data?.length ?? 0) > 0;
}

// Insert exchange rates
export async function insertRates(rates: ExchangeRateInsert[]) {
    const { data, error } = await supabaseAdmin
        .from('exchange_rates')
        .upsert(rates, { onConflict: 'rate_date,source,currency' });

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
