#!/usr/bin/env node
/*
  Backfill missing stock_symbols rows for symbols present in equity_positions.
  Inserts rows with symbol and exchange; symbol_token left NULL for operator to fill.

  Usage: node backend/scripts/backfill_stock_symbols.js
  Requires backend/src/db/supabaseClient.js to export `supabase` client.
*/

import { supabase } from '../src/db/supabaseClient.js';

async function main() {
  try {
    console.log('Fetching symbols from equity_positions...');
    const { data: positions, error: posErr } = await supabase
      .from('equity_positions')
      .select('symbol, exchange')
      .neq('symbol', null);

    if (posErr) throw posErr;
    const symbols = positions.map(p => ({ symbol: (p.symbol || '').trim(), exchange: (p.exchange || 'NSE') }));
    const uniqueSymbols = Array.from(new Map(symbols.map(s => [s.symbol, s])).values()).filter(s => s.symbol);

    if (!uniqueSymbols.length) {
      console.log('No symbols found in equity_positions. Exiting.');
      return;
    }

    const symbolNames = uniqueSymbols.map(s => s.symbol);
    console.log(`Found ${symbolNames.length} unique symbols.`);

    console.log('Checking existing stock_symbols...');
    const { data: existing, error: existErr } = await supabase
      .from('stock_symbols')
      .select('symbol')
      .in('symbol', symbolNames);

    if (existErr) throw existErr;
    const existingSet = new Set((existing || []).map(r => (r.symbol || '').trim()));

    const toInsert = uniqueSymbols.filter(s => !existingSet.has(s.symbol)).map(s => ({
      symbol: s.symbol,
      name: null,
      exchange: s.exchange || 'NSE',
      symbol_token: null,
    }));

    if (!toInsert.length) {
      console.log('No missing symbols to insert into stock_symbols.');
      return;
    }

    console.log(`Inserting ${toInsert.length} rows into stock_symbols (symbol_token left NULL).`);
    const { error: insertErr } = await supabase.from('stock_symbols').insert(toInsert);
    if (insertErr) throw insertErr;

    console.log('Backfill complete. Please populate `symbol_token` values for these entries.');
  } catch (err) {
    console.error('Error running backfill script:', err.message || err);
    process.exit(1);
  }
}

main();
