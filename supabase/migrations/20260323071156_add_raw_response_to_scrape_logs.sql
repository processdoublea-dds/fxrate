-- Add raw_response column to store API responses for debugging purposes
ALTER TABLE scrape_logs 
ADD COLUMN IF NOT EXISTS raw_response JSONB;
