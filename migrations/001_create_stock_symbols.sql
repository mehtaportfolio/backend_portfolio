-- Idempotent migration: create stock_symbols if it doesn't exist
CREATE TABLE IF NOT EXISTS public.stock_symbols (
  symbol text NOT NULL,
  name text NULL,
  created_at timestamp without time zone NULL DEFAULT now(),
  exchange text NULL,
  symbol_token numeric NULL,
  last_updated timestamp with time zone NULL DEFAULT now(),
  CONSTRAINT stock_symbols_pkey PRIMARY KEY (symbol),
  CONSTRAINT stock_symbols_exchange_symbol_key UNIQUE (exchange, symbol)
);

-- Optional: index on symbol_token for faster lookups
CREATE INDEX IF NOT EXISTS idx_stock_symbols_token ON public.stock_symbols (symbol_token);
