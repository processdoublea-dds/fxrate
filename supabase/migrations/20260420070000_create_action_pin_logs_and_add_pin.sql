-- Audit log table to track PIN usage on critical actions
CREATE TABLE IF NOT EXISTS public.action_pin_logs (
  id BIGSERIAL PRIMARY KEY,
  pin_id UUID REFERENCES public.action_pins(id),
  pin_label TEXT,
  action_label TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'success',  -- 'success' or 'failed'
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for querying logs by date
CREATE INDEX idx_action_pin_logs_created_at ON public.action_pin_logs(created_at DESC);

-- RLS
ALTER TABLE public.action_pin_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow insert via service role"
  ON public.action_pin_logs
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow read via service role"
  ON public.action_pin_logs
  FOR SELECT
  USING (true);

-- Also add the new PIN
INSERT INTO public.action_pins (pin_code, label) VALUES ('1938', 'team');

COMMENT ON TABLE public.action_pin_logs IS 'Audit log tracking which PIN was used for which action and when';
