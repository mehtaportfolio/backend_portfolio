ALTER TABLE public.stock_transactions
  ALTER COLUMN quantity TYPE numeric(12,6) USING quantity::numeric(12,6),
  ALTER COLUMN buy_price TYPE numeric(12,6) USING buy_price::numeric(12,6),
  ALTER COLUMN sell_price TYPE numeric(12,6) USING sell_price::numeric(12,6);
