-- Create stock_mapping table for Angel One Smart API prices
-- This table stores real-time prices updated every 5 minutes via cron service

CREATE TABLE IF NOT EXISTS public.stock_mapping (
  id BIGSERIAL PRIMARY KEY,
  stock_name VARCHAR(255) NOT NULL UNIQUE,
  cmp NUMERIC(18, 2),
  lcp NUMERIC(18, 2),
  category VARCHAR(100),
  sector VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index on stock_name for faster lookups
CREATE INDEX IF NOT EXISTS idx_stock_mapping_stock_name ON public.stock_mapping(stock_name);

-- Enable RLS if needed
ALTER TABLE public.stock_mapping ENABLE ROW LEVEL SECURITY;

-- Create policy to allow reading for authenticated users
CREATE POLICY "Enable read access for authenticated users" 
ON public.stock_mapping 
FOR SELECT 
USING (auth.role() = 'authenticated');

-- Grant permissions
GRANT SELECT ON public.stock_mapping TO authenticated;
GRANT SELECT ON public.stock_mapping TO anon;
