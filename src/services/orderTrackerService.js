import cron from 'node-cron';
import * as zerodhaService from './zerodhaService.js';
import * as angelService from './angelOneService.js';
import { supabase } from '../db/supabaseClient.js';

/**
 * Poll for open orders and update their status
 */
export async function trackOrders() {
  try {
    // 1. Fetch open orders from broker_orders table
    const { fetchAllRows } = await import('../db/queries.js');
    const { data: openOrders, error } = await fetchAllRows(supabase, 'broker_orders', {
      filters: [(q) => q.eq('status', 'OPEN')]
    });

    if (error) throw error;
    if (!openOrders || openOrders.length === 0) return;

    console.log(`[OrderTracker] Checking status for ${openOrders.length} open orders...`);

    for (const order of openOrders) {
      try {
        let statusData;
        if (order.broker.toLowerCase() === 'zerodha') {
          statusData = await zerodhaService.getOrderStatus(order.account_id, order.order_id);
        } else {
          statusData = await angelService.getOrderStatus(order.order_id);
        }

        const normalizedStatus = statusData.status.toUpperCase();

        if (normalizedStatus === 'COMPLETE' || normalizedStatus === 'COMPLETED') {
          // 2. Update stock_transactions
          const { error: txError } = await supabase
            .from('stock_transactions')
            .update({
              sell_date: new Date().toISOString().split('T')[0],
              sell_price: statusData.average_price || order.price
            })
            .eq('id', order.transaction_id);

          if (txError) throw txError;

          // 3. Update broker_orders status
          await supabase
            .from('broker_orders')
            .update({ status: 'COMPLETED', updated_at: new Date().toISOString() })
            .eq('id', order.id);

          console.log(`[OrderTracker] Order ${order.order_id} COMPLETED and transaction updated.`);
        } else if (normalizedStatus === 'REJECTED' || normalizedStatus === 'CANCELLED') {
          await supabase
            .from('broker_orders')
            .update({ status: normalizedStatus, updated_at: new Date().toISOString() })
            .eq('id', order.id);
          
          console.log(`[OrderTracker] Order ${order.order_id} ${normalizedStatus}.`);
        }
      } catch (err) {
        console.error(`[OrderTracker] Error tracking order ${order.order_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[OrderTracker] Global tracking error:", err.message);
  }
}

/**
 * Start the order tracking background service
 */
export function startOrderTracker() {
  // Poll every 1 minute during market hours
  // Adjust cron as needed
  cron.schedule('*/1 * * * *', () => {
    // Optional: only track during market hours to save API hits
    // if (isMarketHours()) { ... }
    trackOrders();
  });
  
  console.log("[OrderTracker] Background service started.");
}
