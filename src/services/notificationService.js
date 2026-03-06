import webpush from 'web-push';
import { supabase } from '../db/supabaseClient.js';
import { getDashboardAssetAllocation } from './dashboardService.js';

// Initialize web-push with VAPID keys
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
const vapidEmail = process.env.VAPID_EMAIL;

if (publicVapidKey && privateVapidKey && vapidEmail) {
  webpush.setVapidDetails(vapidEmail, publicVapidKey, privateVapidKey);
}

const toNumber = (val) => {
  const n = parseFloat(val);
  return isFinite(n) ? n : 0;
};

/**
 * Check if current time is within Indian Market Hours (9:15 AM - 3:30 PM IST)
 * @returns {boolean}
 */
const isMarketHours = () => {
  const now = new Date();
  // Convert to IST
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  
  const day = istTime.getUTCDay(); // 0 is Sunday, 6 is Saturday
  const hours = istTime.getUTCHours();
  const minutes = istTime.getUTCMinutes();
  
  console.log(`[Notification] Time check (IST): Day=${day}, Time=${hours}:${minutes.toString().padStart(2, '0')}`);

  // Mon-Fri
  if (day === 0 || day === 6) {
    console.log('[Notification] Skipping: Weekend');
    return false;
  }
  
  const timeInMinutes = hours * 60 + minutes;
  const startInMinutes = 9 * 60 + 15;
  const endInMinutes = 15 * 60 + 40; // Allow slightly more time for final updates
  
  const result = timeInMinutes >= startInMinutes && timeInMinutes <= endInMinutes;
  if (!result) {
    console.log(`[Notification] Skipping: Outside market hours (9:15-15:40). Current: ${hours}:${minutes}`);
  }
  return result;
};

/**
 * Send push notification to all subscribers
 * @param {object} payload - Notification data
 */
export async function sendPushNotification(payload) {
  try {
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('id, subscription');

    if (error) throw error;
    if (!subscriptions || subscriptions.length === 0) {
      console.log('[Notification] No subscribers found');
      return;
    }

    console.log(`[Notification] Sending to ${subscriptions.length} subscribers`);
    const notificationPayload = JSON.stringify(payload);

    const sendPromises = subscriptions.map((sub) => 
      webpush.sendNotification(sub.subscription, notificationPayload)
        .catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`[Notification] Deleting expired subscription ${sub.id}`);
            return supabase.from('push_subscriptions').delete().eq('id', sub.id);
          }
          console.error(`[Notification] Error sending to sub ${sub.id}:`, err);
        })
    );

    await Promise.all(sendPromises);
    console.log('[Notification] Push batch complete');
  } catch (err) {
    console.error('Error in sendPushNotification:', err);
  }
}

// Memory state for notification pausing
let notificationState = {
  lastSentValues: [], // Array of { profit: number, change: number }
  isPausedDueToSameValues: false
};

/**
 * Reset notification state (called by restart endpoint)
 */
export function restartNotifications() {
  notificationState = {
    lastSentValues: [],
    isPausedDueToSameValues: false
  };
  console.log('[Notification] State reset manually');
  return { status: 'success', message: 'Notifications restarted' };
}

/**
 * Trigger portfolio update notification
 * @param {boolean} force - Skip market hours and pause check if true
 */
export async function triggerPortfolioUpdate(force = false) {
  const marketHours = isMarketHours();
  console.log(`[Notification] Triggered (force=${force}, isMarketHours=${marketHours}, isPaused=${notificationState.isPausedDueToSameValues})`);

  if (!force) {
    if (!marketHours) {
      return { status: 'skipped', reason: 'outside_market_hours' };
    }
    if (notificationState.isPausedDueToSameValues) {
      return { status: 'skipped', reason: 'paused_due_to_holiday_or_error' };
    }
  }

  try {
    // We target the primary user accounts. PDM and PSM seem to be part of your portfolio too.
    // BDM is excluded as requested.
    const userIds = ['PM', 'PDM', 'PSM'];
    const result = await getDashboardAssetAllocation(supabase, userIds);
    
    // The user specifically wants Stock + ETF (Equity Button logic)
    const equityRows = result.rows.filter(r => r.assetType === 'Stock' || r.assetType === 'ETF');
    
    const totalMarketValue = equityRows.reduce((sum, r) => sum + r.marketValue, 0);
    const totalInvested = equityRows.reduce((sum, r) => sum + r.investedValue, 0);
    const totalProfit = totalMarketValue - totalInvested;
    const profitPercent = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;
    
    const overallDayChange = equityRows.reduce((sum, r) => sum + r.dayChange, 0);
    const dayChangePercent = (totalMarketValue - overallDayChange) > 0 
      ? (overallDayChange / (totalMarketValue - overallDayChange)) * 100 
      : 0;

    // Check for 3 consecutive same values (Holiday/Error detection)
    if (!force) {
      const currentValues = { 
        profit: Math.round(totalProfit), 
        change: Math.round(overallDayChange) 
      };
      
      const lastValues = notificationState.lastSentValues;
      
      // Check if current is same as previous
      const isSameAsLast = lastValues.length > 0 && 
                           lastValues[lastValues.length - 1].profit === currentValues.profit && 
                           lastValues[lastValues.length - 1].change === currentValues.change;

      if (isSameAsLast) {
        notificationState.lastSentValues.push(currentValues);
        console.log(`[Notification] Same values detected (${lastValues.length} consecutive)`);
        
        if (notificationState.lastSentValues.length >= 3) {
          notificationState.isPausedDueToSameValues = true;
          console.log('[Notification] Pausing further notifications: 3 consecutive same values (Holiday/Error)');
          
          // Still send this 3rd one, but next ones will be skipped
        }
      } else {
        // Different values, reset the tracking but keep the current one
        notificationState.lastSentValues = [currentValues];
      }
    }

    // Aggregate regular stocks by name to check combined profit threshold
    const regularStocksMap = new Map();
    (result.stockHoldings || []).forEach(h => {
      if (h.accountType === 'REGULAR') {
        const existing = regularStocksMap.get(h.stockName) || { invested: 0, marketValue: 0 };
        regularStocksMap.set(h.stockName, {
          invested: existing.invested + h.invested,
          marketValue: existing.marketValue + h.marketValue
        });
      }
    });

    const highProfitRegularStocks = [];
    regularStocksMap.forEach((values, stockName) => {
      const combinedProfitPercent = values.invested > 0 
        ? ((values.marketValue - values.invested) / values.invested) * 100 
        : 0;
      
      if (combinedProfitPercent > 170) {
        highProfitRegularStocks.push({
          stockName,
          profitPercent: combinedProfitPercent
        });
      }
    });

    highProfitRegularStocks.sort((a, b) => b.profitPercent - a.profitPercent);

    let notificationBody = `Profit: ₹${totalProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${profitPercent.toFixed(2)}%)\nDay: ₹${overallDayChange.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${dayChangePercent.toFixed(2)}%)`;

    if (highProfitRegularStocks.length > 0) {
      notificationBody += '\n\nHigh Profit Stocks:';
      highProfitRegularStocks.forEach(s => {
        notificationBody += `\n• ${s.stockName}: ${s.profitPercent.toFixed(0)}%`;
      });
    }

    const payload = {
      title: 'Portfolio Update',
      body: notificationBody,
      icon: '/mainphoto.png',
      badge: '/logo192.png',
      data: {
        url: '/'
      }
    };

    await sendPushNotification(payload);
    return { status: 'sent', data: payload };
  } catch (err) {
    console.error('Error triggering portfolio update:', err);
    throw err;
  }
}

/**
 * Send a notification about the Angel One login status
 * @param {object} statusData
 */
export async function sendAngelOneStatusNotification({ success, message, timestamp, authenticated }) {
  try {
    const payload = {
      title: success ? 'Angel One ✅ SUCCESS' : 'Angel One ❌ FAILURE',
      body: `${message}\nTime: ${timestamp}\nAuthenticated: ${authenticated ? 'Yes' : 'No'}`,
      icon: '/mainphoto.png',
      badge: '/logo192.png',
      data: {
        url: '/'
      }
    };

    await sendPushNotification(payload);
    return { status: 'sent', data: payload };
  } catch (err) {
    console.error('Error sending Angel One status notification:', err);
    throw err;
  }
}
