import { supabase } from '../db/supabaseClient.js';
import * as zerodhaService from '../services/zerodhaService.js';
import * as angelService from '../services/angelOneService.js';
import { fetchAllRows } from '../db/queries.js';

const ALLOWED_ACCOUNTS = ['PM', 'PDM', 'PSM'];
const ALLOWED_BROKERS = ['zerodha', 'angel'];
const ALLOWED_ORDER_TYPES = ['LIMIT', 'MARKET'];
const ALLOWED_TRANSACTION_TYPES = ['BUY', 'SELL'];

export async function getStockMaster(req, res) {
  try {
    // Use fetchAllRows to page through the table and return all rows (no 1000-row cap)
    const { data, error } = await fetchAllRows(supabase, 'stock_master', {
      select: 'stock_name, symbol_token',
      order: { column: 'stock_name', ascending: true },
      chunkSize: 1000 // use 1000-row chunks so pagination continues correctly
    });

    if (error) {
      return res.status(500).json({ error: error.message || 'Failed to fetch stock master' });
    }

    res.json({ stocks: (data || []).map((row) => ({ name: row.stock_name, token: row.symbol_token })) });
  } catch (err) {
    console.error('[BuyOrder] getStockMaster error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}

export async function getStockMasterFull(req, res) {
  try {
    const { data, error } = await fetchAllRows(
      supabase,
      'stock_master',
      {
        select: '*',
        order: { column: 'stock_name', ascending: true }
      }
    );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      data: data || []
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message
    });
  }
}

export async function getSymbolToken(req, res) {
  try {
    const { stock_name, exchange } = req.query;

    if (!stock_name || !exchange) {
      return res.status(400).json({
        error: 'stock_name and exchange are required'
      });
    }
    console.log('stock_name:', stock_name)
console.log('exchange:', exchange)

   const { data, error } = await supabase
  .from('stock_symbols')
  .select('symbol_token,name,exchange')
  .eq('name', stock_name)
  .eq('exchange', exchange.toUpperCase())
  .limit(1)
console.log('Matched rows:', data)
    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      symbol_token: data?.[0]?.symbol_token || ''
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message
    });
  }
}

export async function placeBuyOrder(req, res) {
  try {
    const { account_name, broker, symbol, quantity, order_type, transaction_type, price } = req.body;

    if (!account_name || !broker || !symbol || !quantity || !order_type || !transaction_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ALLOWED_ACCOUNTS.includes(account_name)) {
      return res.status(400).json({ error: 'Invalid account name' });
    }

    if (!ALLOWED_BROKERS.includes(broker.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid broker' });
    }

    if (!ALLOWED_ORDER_TYPES.includes(order_type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid order type' });
    }

    if (!ALLOWED_TRANSACTION_TYPES.includes(transaction_type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid transaction type' });
    }

    if (Number(quantity) <= 0) {
      return res.status(400).json({ error: 'Quantity must be greater than zero' });
    }

    if (order_type.toUpperCase() === 'LIMIT' && (!price || Number(price) <= 0)) {
      return res.status(400).json({ error: 'Limit price is required for LIMIT orders' });
    }

    let result;
    if (broker.toLowerCase() === 'zerodha') {
      const accountId = account_name;
      if (transaction_type.toUpperCase() === 'BUY') {
        result = await zerodhaService.placeBuyOrder(accountId, symbol, Number(quantity), order_type.toUpperCase(), Number(price));
      } else {
        result = await zerodhaService.placeSellOrder(accountId, symbol, Number(quantity), Number(price || 0));
      }
    } else {
      const { data: tokenData, error: tokenError } = await supabase
        .from('stock_master')
        .select('symbol_token')
        .eq('stock_name', symbol)
        .limit(1)
        .single();

      if (tokenError || !tokenData || !tokenData.symbol_token) {
        return res.status(400).json({ error: 'Angel One symbol token is missing for the selected stock in stock_master' });
      }

      result = await angelService.placeBuyOrder(symbol, tokenData.symbol_token.trim(), Number(quantity), order_type.toUpperCase(), Number(price));
    }

    if (result.success) {
      return res.json({ success: true, order_id: result.order_id, result });
    }

    return res.status(500).json({ error: 'Order placement failed' });
  } catch (err) {
    console.error('[BuyOrder] placeBuyOrder error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}

export async function getOpenPositions(req, res) {
  try {
    // Fetch all equity positions from today
    const today = new Date().toISOString().split('T')[0];
    const { data: positions, error } = await fetchAllRows(supabase, 'equity_positions', {
      select: 'id, broker, account_id, symbol, quantity, average_price, last_price, position_date',
      filters: [(q) => q.gte('position_date', today)],
      order: { column: 'position_date', ascending: false }
    });

    if (error) {
      return res.status(500).json({ error: error.message || 'Failed to fetch positions' });
    }

    if (!positions || positions.length === 0) {
      return res.json({ positions: [] });
    }

    // Format positions with PnL calculation
    const formattedPositions = positions.map(pos => {
      // Use last_price from equity_positions, fall back to average_price if not available
      const ltp = parseFloat(pos.last_price) || parseFloat(pos.average_price) || 0;
      const avgPrice = parseFloat(pos.average_price) || 0;
      const qty = parseFloat(pos.quantity) || 0;
      
      const invested = qty * avgPrice;
      const current = qty * ltp;
      const pnl = current - invested;
      const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

      return {
        id: pos.id,
        broker: (pos.broker || 'unknown').charAt(0).toUpperCase() + (pos.broker || 'unknown').slice(1),
        account: pos.account_id || 'N/A',
        symbol: pos.symbol,
        stock_name: pos.symbol,
        quantity: qty,
        entry_price: avgPrice,
        ltp: ltp,
        pnl: Math.round(pnl * 100) / 100,
        pnl_percent: Math.round(pnlPercent * 100) / 100,
        invested: Math.round(invested * 100) / 100,
        current: Math.round(current * 100) / 100
      };
    });

    res.json({ positions: formattedPositions });
  } catch (err) {
    console.error('[BuyOrder] getOpenPositions error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}

async function savePositionsToTransactionsInternal(today) {
  const { data: positions, error: posErr } = await fetchAllRows(supabase, 'equity_positions', {
    select: 'id, broker, account_id, symbol, isin, quantity, average_price, last_price, position_date, exchange',
    filters: [(q) => q.eq('position_date', today)]
  });

  if (posErr) {
    return { ok: false, status: 500, error: posErr.message || 'Failed to fetch positions' };
  }

  if (!positions || positions.length === 0) {
    return { ok: true, inserted: 0, message: 'No positions to save' };
  }

  const rowsToInsert = [];
  const missingPrice = [];
  const skippedAccounts = [];

  for (const pos of positions) {
    const account_id = pos.account_id;

    if (!account_id) {
      skippedAccounts.push({ id: pos.id, symbol: pos.symbol });
      continue;
    }

    if (pos.average_price == null) {
      missingPrice.push({ id: pos.id, symbol: pos.symbol, account_id });
      continue;
    }

    const account_name = account_id === 'P811882' ? 'PM' : account_id;
    const account_type = 'regular';
    const equity_type = account_id === 'P811882' ? 'etf' : 'stock';
    const buy_date = pos.position_date;
    const buy_price = Number(pos.average_price);
    const quantity = pos.quantity != null ? Math.round(Number(pos.quantity)) : 0;
    const broker_name = pos.broker || null;

    let stock_name = pos.symbol || '';
    let mappingFound = false;
    try {
      const { data: symData, error: symErr } = await supabase
        .from('stock_symbols')
        .select('symbol_token')
        .eq('symbol', pos.symbol)
        .eq('exchange', pos.exchange)
        .limit(1)
        .single();

      if (!symErr && symData && symData.symbol_token != null) {
        const token = String(symData.symbol_token);
        const { data: masterData, error: masterErr } = await supabase
          .from('stock_master')
          .select('stock_name')
          .eq('symbol_token', token)
          .limit(1)
          .single();
        if (!masterErr && masterData && masterData.stock_name) {
          stock_name = masterData.stock_name;
          mappingFound = true;
        }
      }
    } catch (e) {
      // ignore mapping error and fallback to symbol with suffix removal
    }

    if (!mappingFound && stock_name) {
      stock_name = stock_name.replace(/[-_]EQ$/i, '');
    }

    rowsToInsert.push({
      account_name,
      account_type,
      equity_type,
      buy_date,
      sell_date: null,
      quantity,
      buy_price,
      sell_price: null,
      stock_name,
      broker_name,
    });
  }

  if (missingPrice.length > 0) {
    return { ok: false, status: 400, error: 'Missing average_price for some positions', missing: missingPrice };
  }

  if (rowsToInsert.length === 0) {
    return { ok: true, inserted: 0, skipped: skippedAccounts.length, message: 'No valid positions to insert' };
  }

  const { data: existingTransactions, error: fetchErr } = await supabase
    .from('stock_transactions')
    .select('account_name, equity_type, buy_date, stock_name, broker_name');

  if (fetchErr) {
    console.error('[BuyOrder] Failed to fetch existing transactions:', fetchErr.message);
    return { ok: false, status: 500, error: 'Failed to check for duplicates' };
  }

  const existingSet = new Set();
  for (const existing of existingTransactions || []) {
    const key = `${existing.account_name}|${existing.equity_type}|${existing.buy_date}|${existing.stock_name}|${existing.broker_name}`;
    existingSet.add(key);
  }

  const rowsToInsertFiltered = [];
  const duplicates = [];

  for (const row of rowsToInsert) {
    const key = `${row.account_name}|${row.equity_type}|${row.buy_date}|${row.stock_name}|${row.broker_name}`;
    if (existingSet.has(key)) {
      duplicates.push(row);
    } else {
      rowsToInsertFiltered.push(row);
    }
  }

  if (rowsToInsertFiltered.length === 0) {
    return { ok: true, inserted: 0, skipped: skippedAccounts.length, duplicates: duplicates.length, message: 'All positions already exist (duplicates)' };
  }

  const { data: inserted, error: insertErr } = await supabase.from('stock_transactions').insert(rowsToInsertFiltered).select();
  if (insertErr) {
    console.error('[BuyOrder] savePositionsToTransactions insert error:', insertErr.message || insertErr);
    return { ok: false, status: 500, error: insertErr.message || 'Failed to insert transactions' };
  }

  return {
    ok: true,
    inserted: (inserted || []).length,
    rows: inserted,
    skipped: skippedAccounts.length,
    duplicates: duplicates.length
  };
}

export async function savePositionsToTransactions(req, res) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await savePositionsToTransactionsInternal(today);

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('[BuyOrder] savePositionsToTransactions error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}

export async function syncOpenPositions(req, res) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const syncResults = [];
    const zerodhaAccounts = ['PM', 'PDM', 'PSM'];

    for (const accountId of zerodhaAccounts) {
      const result = await zerodhaService.fetchAndAggregateTradesForAccount(accountId);
      syncResults.push({ broker: 'zerodha', account: accountId, ...result });
    }

    const angelResult = await angelService.fetchTodayBuyTrades();
    const angelAccount = process.env.ANGEL_CLIENT_ID || 'angel';
    syncResults.push({ broker: 'angel', account: angelAccount, ...angelResult });

    const successCount = syncResults.filter((item) => item.success).length;
    const failureCount = syncResults.length - successCount;
    const response = {
      success: failureCount === 0,
      summary: syncResults.map((item) => ({
        broker: item.broker,
        account: item.account,
        success: item.success,
        message: item.message,
        inserted: item.inserted || 0,
        updated: item.updated || 0
      }))
    };

    if (failureCount > 0) {
      response.partial = successCount > 0;
      response.errors = syncResults
        .filter((item) => !item.success)
        .map((item) => ({ broker: item.broker, account: item.account, message: item.message }));
    }

    if (successCount === 0) {
      return res.status(500).json({ success: false, message: 'All broker syncs failed', ...response });
    }

    try {
      const { refreshAngelPositionSubscriptions } = await import('../services/angelLiveService.js');
      await refreshAngelPositionSubscriptions();
    } catch (refreshErr) {
      console.error('[BuyOrder] refreshAngelPositionSubscriptions error:', refreshErr.message);
    }

    const saveResult = await savePositionsToTransactionsInternal(today);
    if (!saveResult.ok) {
      return res.status(saveResult.status || 500).json({
        success: false,
        ...response,
        save: saveResult,
        error: saveResult.error || 'Failed to save positions'
      });
    }

    response.success = true;
    response.save = saveResult;
    response.inserted = saveResult.inserted || 0;
    response.duplicates = saveResult.duplicates || 0;
    response.skipped = saveResult.skipped || 0;
    response.message = saveResult.inserted > 0
      ? `Synced positions from brokers and saved ${saveResult.inserted} transaction${saveResult.inserted === 1 ? '' : 's'}`
      : saveResult.duplicates > 0
        ? `Synced positions from brokers; ${saveResult.duplicates} duplicate${saveResult.duplicates === 1 ? '' : 's'} skipped`
        : 'Synced positions from brokers; no new transactions were created';

    return res.json(response);
  } catch (err) {
    console.error('[BuyOrder] syncOpenPositions error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}
