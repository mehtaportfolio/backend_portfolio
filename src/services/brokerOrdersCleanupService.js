import cron from 'node-cron';
import { supabase } from '../db/supabaseClient.js';

/**
 * Delete broker_orders rows created before today.
 * Returns an object { deleted: <n> }
 */
export async function cleanOldBrokerOrders() {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Find rows older than today
    const { data: oldRows, error: fetchErr } = await supabase
      .from('broker_orders')
      .select('id, created_at')
      .lt('created_at', `${today}T00:00:00+00:00`);

    if (fetchErr) throw fetchErr;
    if (!oldRows || oldRows.length === 0) {
      console.log('[BrokerOrdersCleanup] No old rows to delete.');
      return { deleted: 0 };
    }

    const ids = oldRows.map((r) => r.id);
    const { data: deleted, error: delErr } = await supabase
      .from('broker_orders')
      .delete()
      .in('id', ids);

    if (delErr) throw delErr;

    console.log(`[BrokerOrdersCleanup] Deleted ${deleted ? deleted.length : 0} old broker_orders rows.`);
    return { deleted: deleted ? deleted.length : 0 };
  } catch (err) {
    console.error('[BrokerOrdersCleanup] Error cleaning old broker_orders:', err.message || err);
    throw err;
  }
}

export function startBrokerOrdersCleanup() {
  // Run once at startup
  cleanOldBrokerOrders().catch(() => {});

  // Schedule daily cleanup at 00:05 server time
  cron.schedule('5 0 * * *', () => {
    console.log('[BrokerOrdersCleanup] Scheduled cleanup running...');
    cleanOldBrokerOrders().catch(() => {});
  });

  console.log('[BrokerOrdersCleanup] Service started; daily cleanup scheduled at 00:05.');
}
