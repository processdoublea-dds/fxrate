-- Add attempted_pin column to store the PIN that was entered (for failed attempts)
ALTER TABLE public.action_pin_logs ADD COLUMN IF NOT EXISTS attempted_pin TEXT;

COMMENT ON COLUMN public.action_pin_logs.attempted_pin IS 'The PIN code that was entered (logged for failed attempts)';
