-- Create broker_orders table for tracking placed broker orders

CREATE TABLE IF NOT EXISTS public.broker_orders (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  broker VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  symbol VARCHAR(255) NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  price NUMERIC(18, 2),
  transaction_id UUID NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_broker_orders_broker ON public.broker_orders(broker);
CREATE INDEX IF NOT EXISTS idx_broker_orders_account_id ON public.broker_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_broker_orders_status ON public.broker_orders(status);

ALTER TABLE public.broker_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for authenticated users"
ON public.broker_orders
FOR SELECT
USING (auth.role() = 'authenticated');

CREATE POLICY "Enable insert access for authenticated users"
ON public.broker_orders
FOR INSERT
WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Enable update access for authenticated users"
ON public.broker_orders
FOR UPDATE
USING (auth.role() = 'authenticated')
WITH CHECK (auth.role() = 'authenticated');

GRANT SELECT, INSERT, UPDATE ON public.broker_orders TO authenticated;
GRANT SELECT ON public.broker_orders TO anon;
