-- Table to store valid PINs for confirming critical dashboard actions
CREATE TABLE IF NOT EXISTS public.action_pins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pin_code TEXT NOT NULL,
  label TEXT DEFAULT 'default',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default PIN
INSERT INTO public.action_pins (pin_code, label) VALUES ('3379', 'default');

-- RLS: allow read for verification via service role
ALTER TABLE public.action_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read active pins via service role"
  ON public.action_pins
  FOR SELECT
  USING (is_active = true);

COMMENT ON TABLE public.action_pins IS 'Stores PIN codes used to confirm critical dashboard actions (Fetch, Export, etc.)';
