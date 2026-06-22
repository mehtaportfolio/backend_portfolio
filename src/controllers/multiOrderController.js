import { supabase } from '../db/supabaseClient.js';
import * as zerodhaService from '../services/zerodhaService.js';
import * as angelService from '../services/angelOneService.js';

const ALLOWED_ACCOUNTS = ['PM', 'PDM', 'PSM'];
const ALLOWED_BROKERS = ['zerodha', 'angel'];
const ALLOWED_ORDER_TYPES = ['LIMIT', 'MARKET'];
const ALLOWED_TRANSACTION_TYPES = ['BUY', 'SELL'];

/**
 * Place multiple buy orders in bulk
 * 
 * Request body:
 * {
 *   orders: [
 *     {
 *       account_name: string,
 *       broker: string,
 *       symbol: string,
 *       quantity: number,
 *       order_type: string ('LIMIT' | 'MARKET'),
 *       transaction_type: string ('BUY' | 'SELL'),
 *       price: number (required for LIMIT, optional for MARKET)
 *     },
 *     ...
 *   ]
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   summary: {
 *     zerodha: { success: number, failed: number, errors: [] },
 *     angel: { success: number, failed: number, errors: [] },
 *     ...
 *   },
 *   total: {
 *     success: number,
 *     failed: number
 *   }
 * }
 */
export async function placeMultiBuyOrder(req, res) {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'Orders array is required and must not be empty' });
    }

    // Validate all orders first
    for (const order of orders) {
      const { account_name, broker, symbol, quantity, order_type, transaction_type, price } = order;

      if (!account_name || !broker || !symbol || !quantity || !order_type || !transaction_type) {
        return res.status(400).json({ error: 'All orders must have required fields' });
      }

      if (!ALLOWED_ACCOUNTS.includes(account_name)) {
        return res.status(400).json({ error: `Invalid account name: ${account_name}` });
      }

      if (!ALLOWED_BROKERS.includes(broker.toLowerCase())) {
        return res.status(400).json({ error: `Invalid broker: ${broker}` });
      }

      if (!ALLOWED_ORDER_TYPES.includes(order_type.toUpperCase())) {
        return res.status(400).json({ error: `Invalid order type: ${order_type}` });
      }

      if (!ALLOWED_TRANSACTION_TYPES.includes(transaction_type.toUpperCase())) {
        return res.status(400).json({ error: `Invalid transaction type: ${transaction_type}` });
      }

      if (Number(quantity) <= 0) {
        return res.status(400).json({ error: 'Quantity must be greater than zero' });
      }

      if (order_type.toUpperCase() === 'LIMIT' && (!price || Number(price) <= 0)) {
        return res.status(400).json({ error: 'Limit price is required for LIMIT orders' });
      }
    }

    // Group orders by broker for batch processing
    const brokerGroups = {};
    for (const order of orders) {
      const brokerKey = order.broker.toLowerCase();
      if (!brokerGroups[brokerKey]) {
        brokerGroups[brokerKey] = [];
      }
      brokerGroups[brokerKey].push(order);
    }

    // Process each broker's orders
    const summary = {};
    let totalSuccess = 0;
    let totalFailed = 0;

    for (const [broker, brokerOrders] of Object.entries(brokerGroups)) {
      summary[broker] = { success: 0, failed: 0, errors: [] };

      for (const order of brokerOrders) {
        try {
          const { account_name, symbol, quantity, order_type, transaction_type, price } = order;

          let result;
          if (broker === 'zerodha') {
            const accountId = account_name;
            if (transaction_type.toUpperCase() === 'BUY') {
              result = await zerodhaService.placeBuyOrder(
                accountId,
                symbol,
                Number(quantity),
                order_type.toUpperCase(),
                Number(price)
              );
            } else {
              result = await zerodhaService.placeSellOrder(
                accountId,
                symbol,
                Number(quantity),
                Number(price || 0)
              );
            }
          } else {
            // Angel One
            const { data: tokenData, error: tokenError } = await supabase
              .from('stock_master')
              .select('symbol_token')
              .eq('stock_name', symbol)
              .limit(1)
              .single();

            if (tokenError || !tokenData || !tokenData.symbol_token) {
              throw new Error(`Angel One symbol token is missing for ${symbol}`);
            }

            result = await angelService.placeBuyOrder(
              symbol,
              tokenData.symbol_token.trim(),
              Number(quantity),
              order_type.toUpperCase(),
              Number(price)
            );
          }

          if (result.success) {
            summary[broker].success += 1;
            totalSuccess += 1;
          } else {
            summary[broker].failed += 1;
            summary[broker].errors.push({
              symbol,
              error: result.error || 'Order placement failed',
            });
            totalFailed += 1;
          }
        } catch (error) {
          summary[broker].failed += 1;
          summary[broker].errors.push({
            symbol: order.symbol,
            error: error.message || 'Internal error',
          });
          totalFailed += 1;
        }
      }
    }

    res.json({
      success: totalFailed === 0,
      summary,
      total: {
        success: totalSuccess,
        failed: totalFailed,
      },
    });
  } catch (err) {
    console.error('[MultiOrder] placeMultiBuyOrder error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
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
    return { error: tokenError?.message || `Angel One symbol token is missing for ${symbol}` };
  }

  return { token: tokenData.symbol_token.trim() };
}

export async function placeMultiSellOrder(req, res) {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'Orders array is required and must not be empty' });
    }

    const summary = {};
    let totalSuccess = 0;
    let totalFailed = 0;

    for (const order of orders) {
      const { account_id, broker, symbol, quantity, order_type, price, transaction_id } = order;

      if (!account_id || !broker || !symbol || !quantity || !order_type || !transaction_id) {
        return res.status(400).json({ error: 'All orders must have required fields' });
      }

      const normalizedOrderType = order_type.toUpperCase();
      if (normalizedOrderType !== 'LIMIT' && normalizedOrderType !== 'MARKET') {
        return res.status(400).json({ error: `Invalid order type: ${order_type}` });
      }

      if (normalizedOrderType === 'LIMIT' && (!price || Number(price) <= 0)) {
        return res.status(400).json({ error: 'Limit price is required for LIMIT orders' });
      }

      const brokerKey = broker.toLowerCase();
      if (!summary[brokerKey]) {
        summary[brokerKey] = { success: 0, failed: 0, errors: [] };
      }

      try {
        let result;
        if (brokerKey === 'zerodha') {
          result = await zerodhaService.placeSellOrder(
            account_id,
            symbol,
            Number(quantity),
            normalizedOrderType,
            normalizedOrderType === 'LIMIT' ? Number(price) : 0
          );
        } else if (brokerKey === 'angel' || brokerKey === 'angelone') {
          const { token, error: tokenError } = await resolveAngelSymbolToken(symbol);
          if (tokenError) {
            throw new Error(tokenError);
          }
          result = await angelService.placeSellOrder(
            symbol,
            token,
            Number(quantity),
            normalizedOrderType === 'LIMIT' ? Number(price) : 0
          );
        } else {
          throw new Error(`Invalid broker: ${broker}`);
        }

        if (result.success) {
          const { error: orderError } = await supabase.from('broker_orders').insert([{
            order_id: result.order_id,
            broker,
            account_id,
            symbol,
            quantity,
            price: normalizedOrderType === 'LIMIT' ? price : null,
            transaction_id,
            status: 'OPEN',
            created_at: new Date().toISOString(),
          }]);

          if (orderError) {
            console.error('Error storing broker order:', orderError.message);
            summary[brokerKey].failed += 1;
            summary[brokerKey].errors.push({ symbol, error: `Failed to store broker order: ${orderError.message}` });
            totalFailed += 1;
          } else {
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
            
            summary[brokerKey].success += 1;
            totalSuccess += 1;
          }
        } else {
          summary[brokerKey].failed += 1;
          summary[brokerKey].errors.push({ symbol, error: result.error || 'Order placement failed' });
          totalFailed += 1;
        }
      } catch (err) {
        summary[brokerKey].failed += 1;
        summary[brokerKey].errors.push({ symbol, error: err.message || 'Internal error' });
        totalFailed += 1;
      }
    }

    res.json({
      success: totalFailed === 0,
      summary,
      total: {
        success: totalSuccess,
        failed: totalFailed,
      },
    });
  } catch (err) {
    console.error('[MultiOrder] placeMultiSellOrder error:', err.message);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}
