-- FX Currency Rate Scraping — Initial Schema
-- Run this on Supabase SQL Editor

-- Exchange rates table
CREATE TABLE IF NOT EXISTS exchange_rates (
    id              BIGSERIAL PRIMARY KEY,
    run_id          UUID NOT NULL DEFAULT gen_random_uuid(),
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rate_date       DATE NOT NULL,
    source          VARCHAR(20) NOT NULL,
    currency        VARCHAR(10) NOT NULL,
    currency_label  VARCHAR(50),
    sell_tt         DECIMAL(12,5),
    sell_notes      DECIMAL(12,5),
    buy_tt          DECIMAL(12,5),
    buy_sight       DECIMAL(12,5),
    buy_transfer    DECIMAL(12,5),
    buy_notes       DECIMAL(12,5),
    mid_rate        DECIMAL(12,5),
    bank_timestamp  TIMESTAMPTZ,
    raw_data        JSONB,
    UNIQUE(rate_date, source, currency)
);

-- Scrape logs table
CREATE TABLE IF NOT EXISTS scrape_logs (
    id            BIGSERIAL PRIMARY KEY,
    run_id        UUID NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    source        VARCHAR(20) NOT NULL,
    status        VARCHAR(20) NOT NULL,
    records_count INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms   INTEGER
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rates_date_source ON exchange_rates(rate_date, source);
CREATE INDEX IF NOT EXISTS idx_rates_currency ON exchange_rates(currency, rate_date);
CREATE INDEX IF NOT EXISTS idx_rates_run_id ON exchange_rates(run_id);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_date ON scrape_logs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_source ON scrape_logs(source, started_at DESC);

-- Enable RLS
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_logs ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (for API routes)
CREATE POLICY "service_role_all_exchange_rates"
    ON exchange_rates FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY "service_role_all_scrape_logs"
    ON scrape_logs FOR ALL
    USING (true)
    WITH CHECK (true);

-- Allow anon read for frontend dashboard
CREATE POLICY "anon_read_exchange_rates"
    ON exchange_rates FOR SELECT
    USING (true);

CREATE POLICY "anon_read_scrape_logs"
    ON scrape_logs FOR SELECT
    USING (true);
