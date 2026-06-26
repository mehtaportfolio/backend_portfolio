import * as zerodhaService from '../services/zerodhaService.js';
import * as angelService from '../services/angelOneService.js';
import { fetchAllRows, deleteRows } from '../db/queries.js';
import { supabase } from '../db/supabaseClient.js';
import { getLivePrice as getAngelLivePrice, subscribeSingleStock} from '../services/angelLiveService.js';

/**
 * Get distinct brokers and accounts from stock_transactions
 */
export async function getDistinctBrokersAndAccounts(req, res) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'stock_transactions', {
      select: 'broker_name, account_name',
      filters: [(query) => query.is('sell_date', null)],
      chunkSize: 1000,
    });

    if (error) {
      console.error("[getDistinctBrokersAndAccounts] DB Error:", error.message);
      throw error;
    }

    // Normalize and extract distinct values
    const brokerMap = data
      .map((t) => (typeof t.broker_name === 'string' ? t.broker_name.trim() : ''))
      .filter(Boolean)
      .reduce((map, brokerName) => {
        const key = brokerName.toLowerCase();
        if (!map.has(key)) map.set(key, brokerName);
        return map;
      }, new Map());

    const accountMap = data
      .map((t) => (typeof t.account_name === 'string' ? t.account_name.trim() : ''))
      .filter(Boolean)
      .reduce((map, accountName) => {
        const key = accountName.toLowerCase();
        if (!map.has(key)) map.set(key, accountName);
        return map;
      }, new Map());

    const brokers = Array.from(brokerMap.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const accounts = Array.from(accountMap.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    res.json({
      brokers,
      accounts,
    });
  } catch (error) {
    console.error("Error getting distinct brokers and accounts:", error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Fetch distinct stock names for a broker/account
 */
export async function getDistinctStockNames(req, res) {
  try {
    const { account_name, broker_name, search } = req.query;

    const filters = [];
    if (search) {
      filters.push((query) => query.ilike('stock_name', `%${search}%`));
    }

    const filtersWithBrokerAccount = [
      ...(filters || []),
      ...(broker_name
        ? [
            (query) => query.ilike('broker_name', `%${broker_name.trim()}%`),
          ]
        : []),
      ...(account_name
        ? [
            (query) => query.ilike('account_name', `%${account_name.trim()}%`),
          ]
        : []),
    ];

    const { data, error } = await fetchAllRows(supabase, 'stock_transactions', {
      select: 'stock_name',
      filters: filtersWithBrokerAccount,
      chunkSize: 1000,
    });

    if (error) {
      console.error('[getDistinctStockNames] DB Error:', error.message);
      throw error;
    }

    const uniqueStocks = Array.from(
      new Set(data.map((item) => item.stock_name).filter(Boolean))
    )
      .sort((a, b) => a.localeCompare(b))
      .map((stock_name) => ({ stock_name }));

    res.json({ stocks: uniqueStocks });
  } catch (error) {
    console.error('Error getting distinct stock names:', error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Fetch open transactions for a specific stock and account
 */
export async function getOpenTransactions(req, res) {
  try {
    const { account_name, broker_name, symbol, search, page = 1, limit = 20, equity_type } = req.query;

    // console.log("[getOpenTransactions] Query Params:", { account_name, broker_name, symbol, search, equity_type });

    let query = supabase
      .from('stock_transactions')
      .select('*', { count: 'exact' })
      .is('sell_date', null);

    if (broker_name) {
      query = query.ilike('broker_name', broker_name.trim());
    }

    // Only add account_name filter if it's provided
    if (account_name) {
      query = query.ilike('account_name', account_name.trim());
    }

    if (equity_type) {
      const types = Array.isArray(equity_type) ? equity_type : [equity_type];
      query = query.in('equity_type', types);
    }

    if (symbol) {
      query = query.eq('stock_name', symbol);
    } else if (search) {
      query = query.ilike('stock_name', `%${search}%`);
    }

    const parsedLimit = Number.isInteger(Number(limit)) ? parseInt(limit, 10) : 20;
    const useFetchAll = parsedLimit >= 10000 || parsedLimit <= 0;

    let data;
    let error;
    let count = 0;

    if (useFetchAll) {
      const fetchFilters = [
        ...(equity_type ? [
          (query) => {
            const types = Array.isArray(equity_type) ? equity_type : [equity_type];
            return query.in('equity_type', types);
          }
        ] : []),
        ...(symbol ? [(query) => query.eq('stock_name', symbol)] : []),
        ...(!symbol && search ? [(query) => query.ilike('stock_name', `%${search}%`)] : []),
        ...(broker_name ? [(query) => query.ilike('broker_name', broker_name.trim())] : []),
        ...(account_name ? [(query) => query.ilike('account_name', account_name.trim())] : []),
        (query) => query.is('sell_date', null),
      ];

      const result = await fetchAllRows(supabase, 'stock_transactions', {
        select: '*',
        filters: fetchFilters,
        order: { column: 'buy_date', ascending: true },
        chunkSize: 1000,
      });

      data = result.data;
      error = result.error;
      count = data.length;
    } else {
      const from = (page - 1) * parsedLimit;
      const to = from + parsedLimit - 1;

      const result = await query
        .order('buy_date', { ascending: true })
        .range(from, to);

      data = result.data;
      error = result.error;
      count = result.count;
    }

    if (error) {
      console.error("[getOpenTransactions] DB Error:", error.message);
      throw error;
    }

    // console.log(`[getOpenTransactions] Found ${data.length} rows for search "${search || symbol || ''}"`);

    res.json({
      data,
      count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    console.error("Error fetching open transactions:", error.message);
    res.status(500).json({ error: error.message });
  }
}

async function resolveAngelSymbolToken(symbol) {
  const stockName = (symbol || '').trim();
  if (!stockName) {
    return { error: 'Stock symbol is required for Angel One orders' };
  }

  const { data: tokenData, error: tokenError } = await supabase
    .from('stock_master')
    .select('symbol_token')
    .eq('stock_name', stockName)
    .limit(1)
    .single();

  if (tokenError || !tokenData || !tokenData.symbol_token) {
    return { error: tokenError?.message || 'Angel One symbol token is missing for the selected stock in stock_master' };
  }

  return { token: tokenData.symbol_token.trim() };
}

/**
 * Place a sell order
 */
export async function placeSellOrder(req, res) {
  try {
    const { broker, account_id, symbol, quantity, price, transaction_id, order_type } = req.body;

    if (!broker || !account_id || !symbol || !quantity) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const normalizedOrderType = (order_type || 'LIMIT').toUpperCase();
    if (normalizedOrderType !== 'LIMIT' && normalizedOrderType !== 'MARKET') {
      return res.status(400).json({ error: "Invalid order_type. Must be LIMIT or MARKET" });
    }

    if (normalizedOrderType === 'LIMIT' && (!price || parseFloat(price) <= 0)) {
      return res.status(400).json({ error: "Limit price is required for LIMIT orders" });
    }

    let result;
    const normalizedBroker = String(broker).trim().toLowerCase().replace(/\s+/g, '');
    if (normalizedBroker === 'zerodha') {
      result = await zerodhaService.placeSellOrder(account_id, symbol, quantity, normalizedOrderType, price);
    } else if (normalizedBroker === 'angel' || normalizedBroker === 'angelone') {
      const { token: resolvedToken, error: tokenError } = await resolveAngelSymbolToken(symbol);
      if (tokenError) {
        return res.status(400).json({ error: tokenError });
      }

      result = await angelService.placeSellOrder(symbol, resolvedToken, quantity, price);
    } else {
      return res.status(400).json({ error: "Invalid broker" });
    }

    if (result.success) {
      // Store the order in a new 'orders' table for tracking
      const { error: orderError } = await supabase
        .from('broker_orders')
        .insert([{
          order_id: result.order_id,
          broker: String(broker).trim(),
          account_id,
          symbol,
          quantity,
          price,
          transaction_id: transaction_id || null,
          status: 'OPEN',
          created_at: new Date().toISOString()
        }]);

      if (orderError) {
        console.error("Error storing order in DB:", orderError.message);
        return res.status(500).json({ error: "Failed to store broker order", details: orderError.message });
      }

      // After successful order placement, delete the position from equity_positions if it exists
      // Match by account_id, symbol, and quantity
      const { data: existingPositions, error: queryError } = await supabase
        .from('equity_positions')
        .select('id')
        .eq('account_id', account_id)
        .eq('symbol', symbol)
        .eq('quantity', quantity);

      if (queryError) {
        console.error('Error querying equity_positions:', queryError.message);
      } else if (existingPositions && existingPositions.length > 0) {
        // Position exists, delete it
        const positionId = existingPositions[0].id;
        const { error: deleteError } = await supabase
          .from('equity_positions')
          .delete()
          .eq('id', positionId);
        
        if (deleteError) {
          console.error('Error deleting equity_positions row:', deleteError.message);
        } else {
          console.log(`Deleted equity_positions for ${symbol} (${account_id}) after sell order placement`);
        }
      } else {
        console.log(`No equity_positions found for ${symbol} (${account_id}), proceeding with order`);
      }

      // Order is stored in broker_orders table for tracking.
      // sell_date/sell_price in stock_transactions will be updated when order is confirmed/executed.
      res.json({ success: true, order_id: result.order_id });
    } else {
      res.status(500).json({ error: "Failed to place order" });
    }
  } catch (error) {
    console.error("Error placing sell order:", error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get status of an order
 */
export async function getOrderStatus(req, res) {
  try {
    const { order_id, broker, account_id } = req.query;

    if (!order_id || !broker) {
      return res.status(400).json({ error: "order_id and broker are required" });
    }

    let status;
    if (broker.toLowerCase() === 'zerodha') {
      status = await zerodhaService.getOrderStatus(account_id, order_id);
    } else if (broker.toLowerCase() === 'angel' || broker.toLowerCase() === 'angelone') {
      status = await angelService.getOrderStatus(order_id);
    }

    res.json(status);
  } catch (error) {
    console.error("Error getting order status:", error.message);
    res.status(500).json({ error: error.message });
  }
}



export const getLivePrice = async (req, res) => {
  const { symbol } = req.params;

  let ltp = getAngelLivePrice(symbol);

  if (ltp == null) {
    await subscribeSingleStock(symbol);

    return res.json({
      success: true,
      symbol,
      ltp: null,
      subscribing: true
    });
  }

  return res.json({
    success: true,
    symbol,
    ltp
  });
};

export async function subscribeStock(req, res) {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required'
      });
    }

    await subscribeSingleStock(`${symbol}-EQ`);

    return res.json({
      success: true
    });

  } catch (err) {
    console.error('[Subscribe Stock]', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

