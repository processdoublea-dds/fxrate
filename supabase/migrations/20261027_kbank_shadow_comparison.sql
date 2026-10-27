-- Optional dedicated table for KBANK Shadow Testing
CREATE TABLE IF NOT EXISTS public.kbank_shadow_comparison (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rate_date DATE NOT NULL,
    tested_at TIMESTAMPTZ DEFAULT NOW(),
    match_status TEXT NOT NULL,
    currencies_checked INT DEFAULT 26,
    diff_count INT DEFAULT 0,
    browserless_timestamp TIMESTAMPTZ,
    browserless_round TEXT,
    browserless_duration_ms INT,
    browserless_rates JSONB,
    browseract_timestamp TIMESTAMPTZ,
    variance_details JSONB,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_kbank_shadow_date ON public.kbank_shadow_comparison(rate_date DESC);
