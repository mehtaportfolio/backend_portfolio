import webpush from 'web-push';
import axios from 'axios';
import { supabase } from '../db/supabaseClient.js';
import { getDashboardAssetAllocation } from './dashboardService.js';

// Initialize web-push with VAPID keys
const initWebPush = () => {
  const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
  const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail = process.env.VAPID_EMAIL;

  if (publicVapidKey && privateVapidKey && vapidEmail) {
    console.log('[Notification] Initializing WebPush with VAPID email:', vapidEmail);
    try {
      webpush.setVapidDetails(vapidEmail, publicVapidKey, privateVapidKey);
      return true;
    } catch (err) {
      console.error('[Notification] Failed to set VAPID details:', err.message);
      return false;
    }
  }
  console.warn('[Notification] VAPID keys missing in environment variables');
  return false;
};

// Call once at startup
initWebPush();

/**
 * Send Telegram Alert
 * @param {object} payload - Notification data
 */
export async function sendTelegramAlert(payload) {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (!telegramBotToken || !telegramChatId) {
    console.log('[Notification] Telegram Bot Token or Chat ID not configured, skipping Telegram alert');
    return;
  }

  const truncatedToken = telegramBotToken.substring(0, 10) + '...';
  console.log(`[Notification] Sending Telegram alert to chat ${telegramChatId} using bot ${truncatedToken}`);

  try {
    // Escape characters for HTML (only basics as we want to preserve tags we add)
    const escapeHTML = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    const escapedTitle = escapeHTML(payload.title);
    const escapedBody = escapeHTML(payload.body);
    
    const message = `<b>${escapedTitle}</b>\n\n${escapedBody}`;
    
    const response = await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      chat_id: telegramChatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, {
      timeout: 10000 
    });

    if (response.data && response.data.ok) {
      console.log('[Notification] Telegram alert sent successfully');
    } else {
      console.error('[Notification] Telegram alert failed with response:', response.data);
    }
  } catch (err) {
    const errorData = err.response?.data;
    console.error('[Notification] Error sending Telegram alert:', errorData || err.message);
    
    // Fallback: try sending without HTML parse mode if HTML parsing failed
    if (errorData && errorData.description && errorData.description.includes('can\'t parse entities')) {
      console.log('[Notification] Retrying Telegram alert without HTML formatting...');
      try {
        const plainMessage = `${payload.title}\n\n${payload.body}`;
        await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          chat_id: telegramChatId,
          text: plainMessage
        });
        console.log('[Notification] Telegram alert sent successfully (fallback plain text)');
      } catch (retryErr) {
        console.error('[Notification] Fallback Telegram alert also failed:', retryErr.message);
      }
    }
  }
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
 * @param {number} threshold - Profit percentage threshold for regular stocks (optional)
 */
export async function triggerPortfolioUpdate(force = false, threshold = null) {
  const marketHours = isMarketHours();
  
  // Use provided threshold or fetch from user_details
  let profitThresholdToUse = threshold !== null && !isNaN(parseFloat(threshold)) ? parseFloat(threshold) : null;
  
  if (profitThresholdToUse === null) {
    try {
      const { data: userDetails, error: userError } = await supabase
        .from('user_details')
        .select('"profit%"')
        .eq('id', 1) // Assuming single user with ID 1 based on my check
        .single();
      
      if (!userError && userDetails && userDetails['profit%'] !== null) {
        profitThresholdToUse = parseFloat(userDetails['profit%']);
        console.log(`[Notification] Using persisted threshold from user_details: ${profitThresholdToUse}%`);
      } else {
        profitThresholdToUse = 170; // Default if not found
        console.log(`[Notification] No persisted threshold found, using default: ${profitThresholdToUse}%`);
      }
    } catch (err) {
      console.error('[Notification] Error fetching threshold from user_details:', err);
      profitThresholdToUse = 170;
    }
  }
  
  console.log(`[Notification] Triggered (force=${force}, inputThreshold=${threshold}, effectiveThreshold=${profitThresholdToUse}, isMarketHours=${marketHours}, isPaused=${notificationState.isPausedDueToSameValues})`);

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
      // Only include 'REGULAR' account types (case-insensitive)
      const accountType = (h.accountType || '').toUpperCase();
      
      if (accountType === 'REGULAR') {
        const existing = regularStocksMap.get(h.stockName) || { invested: 0, marketValue: 0, quantity: 0, cmp: 0 };
        regularStocksMap.set(h.stockName, {
          invested: existing.invested + h.invested,
          marketValue: existing.marketValue + h.marketValue,
          quantity: existing.quantity + h.quantity,
          cmp: h.cmp // CMP is consistent for same stock name
        });
      }
    });

    const highProfitRegularStocks = [];
    regularStocksMap.forEach((values, stockName) => {
      const combinedProfitPercent = values.invested > 0 
        ? ((values.marketValue - values.invested) / values.invested) * 100 
        : 0;
      
      const avgBuyPrice = values.quantity > 0 ? values.invested / values.quantity : 0;
      
      // Use >= for inclusive check
      if (combinedProfitPercent >= profitThresholdToUse) {
        highProfitRegularStocks.push({
          stockName,
          profitPercent: combinedProfitPercent,
          cmp: values.cmp,
          avgBuyPrice
        });
      }
    });

    highProfitRegularStocks.sort((a, b) => b.profitPercent - a.profitPercent);

    // Limit to top 15 stocks to avoid payload size issues
    const displayStocks = highProfitRegularStocks.slice(0, 15);

    let notificationBody = `P&L: ₹${totalProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${profitPercent.toFixed(0)}%) | Day: ₹${overallDayChange.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${dayChangePercent.toFixed(0)}%)`;

    if (displayStocks.length > 0) {
      notificationBody += `\n🔥 High Profit (${highProfitRegularStocks.length}):`;
      displayStocks.forEach(s => {
        notificationBody += `\n• ${s.stockName}: ${s.profitPercent.toFixed(0)}% (C:${s.cmp.toFixed(0)}, A:${s.avgBuyPrice.toFixed(0)})`;
      });
    }

    // Fetch Corporate Actions for Today (IST)
    try {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(now.getTime() + istOffset);
      const todayIST = istTime.toISOString().split('T')[0];

      const { data: bonusActions, error: bonusError } = await supabase
        .from('bonus_split')
        .select('stock_name, type, ratio')
        .eq('date', todayIST)
        .eq('status', 'active');

      if (!bonusError && bonusActions && bonusActions.length > 0) {
        notificationBody += '\n⚡ Action Today:';
        // Use unique actions (different sources might have same action)
        const uniqueActions = [];
        const seen = new Set();
        bonusActions.forEach(a => {
          const key = `${a.stock_name}|${a.type}|${a.ratio}`;
          if (!seen.has(key)) {
            uniqueActions.push(a);
            seen.add(key);
          }
        });

        uniqueActions.forEach(a => {
          notificationBody += `\n• ${a.stock_name}: ${a.type} (${a.ratio})`;
        });
      }
    } catch (e) {
      console.error('[Notification] Error fetching bonus actions:', e);
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

    // Send notifications in parallel so failure in one doesn't stop the other
    const results = await Promise.allSettled([
      sendPushNotification(payload),
      sendTelegramAlert(payload)
    ]);

    results.forEach((res, idx) => {
      if (res.status === 'rejected') {
        console.error(`[Notification] Alert ${idx === 0 ? 'Push' : 'Telegram'} failed:`, res.reason);
      }
    });

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

    // Send notifications in parallel
    const results = await Promise.allSettled([
      sendPushNotification(payload),
      sendTelegramAlert(payload)
    ]);

    results.forEach((res, idx) => {
      if (res.status === 'rejected') {
        console.error(`[Notification] Angel One Alert ${idx === 0 ? 'Push' : 'Telegram'} failed:`, res.reason);
      }
    });

    return { status: 'sent', data: payload };
  } catch (err) {
    console.error('Error sending Angel One status notification:', err);
    throw err;
  }
}
