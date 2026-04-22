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
    // console.log('[Notification] Initializing WebPush with VAPID email:', vapidEmail);
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
    const missing = [];
    if (!telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
    if (!telegramChatId) missing.push('TELEGRAM_CHAT_ID');
    // console.warn(`[Notification] Telegram alert skipped: Missing ${missing.join(' and ')}`);
    return false;
  }

  const truncatedToken = telegramBotToken.substring(0, 10) + '...';
  // console.log(`[Notification] Sending Telegram alert to chat ${telegramChatId} using bot ${truncatedToken}`);

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
      // console.log('[Notification] Telegram alert sent successfully');
      return true;
    } else {
      console.error('[Notification] Telegram alert failed with response:', response.data);
      throw new Error(`Telegram API responded with error: ${JSON.stringify(response.data)}`);
    }
  } catch (err) {
    const errorData = err.response?.data;
    const errorDesc = errorData?.description || err.message;
    console.error('[Notification] Error sending Telegram alert:', errorDesc);
    
    // Fallback: try sending without HTML parse mode if HTML parsing failed or any other formatting error
    // console.log('[Notification] Retrying Telegram alert with plain text fallback...');
    try {
      const plainMessage = `${payload.title}\n\n${payload.body}`;
      const fallbackResponse = await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        chat_id: telegramChatId,
        text: plainMessage,
        disable_web_page_preview: true
      });
      
      if (fallbackResponse.data && fallbackResponse.data.ok) {
        // console.log('[Notification] Telegram alert sent successfully (fallback plain text)');
        return true;
      }
      throw new Error('Fallback also failed');
    } catch (retryErr) {
      console.error('[Notification] Fallback Telegram alert also failed:', retryErr.response?.data || retryErr.message);
      
      // Last resort: Extremely simple message
      try {
        // console.log('[Notification] Attempting last-resort simple alert...');
        await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          chat_id: telegramChatId,
          text: `Portfolio Alert: ${payload.title}. Check app for details.`
        });
        return true;
      } catch (lastErr) {
        console.error('[Notification] All Telegram delivery attempts failed');
        throw lastErr;
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
  
  // console.log(`[Notification] Time check (IST): Day=${day}, Time=${hours}:${minutes.toString().padStart(2, '0')}`);

  // Mon-Fri
  if (day === 0 || day === 6) {
    // console.log('[Notification] Skipping: Weekend');
    return false;
  }
  
  const timeInMinutes = hours * 60 + minutes;
  const startInMinutes = 9 * 60 + 15;
  const endInMinutes = 15 * 60 + 40; // Allow slightly more time for final updates
  
  const result = timeInMinutes >= startInMinutes && timeInMinutes <= endInMinutes;
  // if (!result) {
  //   console.log(`[Notification] Skipping: Outside market hours (9:15-15:40). Current: ${hours}:${minutes}`);
  // }
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
      // console.log('[Notification] No subscribers found');
      return;
    }

    // console.log(`[Notification] Sending to ${subscriptions.length} subscribers`);
    const notificationPayload = JSON.stringify(payload);

    const sendPromises = subscriptions.map((sub) => 
      webpush.sendNotification(sub.subscription, notificationPayload)
        .catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // console.log(`[Notification] Deleting expired subscription ${sub.id}`);
            return supabase.from('push_subscriptions').delete().eq('id', sub.id);
          }
          console.error(`[Notification] Error sending to sub ${sub.id}:`, err);
        })
    );

    await Promise.all(sendPromises);
    // console.log('[Notification] Push batch complete');
  } catch (err) {
    console.error('Error in sendPushNotification:', err);
  }
}

// Memory state for notification pausing
let notificationState = {
  mobile: {
    lastSentValues: [], // Array of { profit: number, change: number }
    isPausedDueToSameValues: false,
  },
  telegram: {
    lastSentValues: [],
    isPausedDueToSameValues: false,
  },
  isTelegramEnabled: true // Default to true
};

/**
 * Reset notification state (called by restart endpoint)
 * @param {string} type - 'mobile', 'telegram', or 'all'
 */
export function restartNotifications(type = 'all') {
  if (type === 'all' || type === 'mobile') {
    notificationState.mobile.lastSentValues = [];
    notificationState.mobile.isPausedDueToSameValues = false;
  }
  if (type === 'all' || type === 'telegram') {
    notificationState.telegram.lastSentValues = [];
    notificationState.telegram.isPausedDueToSameValues = false;
  }
  // console.log(`[Notification] State reset manually for: ${type}`);
  return { status: 'success', message: `Notifications restarted for ${type}` };
}

/**
 * Fetch notification settings from user_details
 * @returns {Promise<object>}
 */
async function fetchNotificationSettings() {
  try {
    const { data: userDetails, error } = await supabase
      .from('user_details')
      .select('*')
      .eq('id', 1)
      .single();
    
    if (error) throw error;
    
    if (userDetails) {
      if (userDetails.telegram_enabled !== undefined) {
        notificationState.isTelegramEnabled = userDetails.telegram_enabled !== false;
      }
      return userDetails;
    }
  } catch (err) {
    console.error('[Notification] Error fetching notification settings:', err.message);
  }
  return null;
}

/**
 * Trigger portfolio update notification
 * @param {boolean} force - Skip market hours and pause check if true
 * @param {number} threshold - Profit percentage threshold for regular stocks (optional)
 * @param {string} type - Notification type: 'mobile', 'telegram', or 'all'
 */
export async function triggerPortfolioUpdate(force = false, threshold = null, type = 'all') {
  const marketHours = isMarketHours();
  
  // Use provided threshold or fetch from user_details
  let profitThresholdToUse = threshold !== null && !isNaN(parseFloat(threshold)) ? parseFloat(threshold) : null;
  
  const userDetails = await fetchNotificationSettings();
  if (userDetails && profitThresholdToUse === null) {
    if (userDetails['profit%'] !== null) {
      profitThresholdToUse = parseFloat(userDetails['profit%']);
    }
  }

  if (profitThresholdToUse === null) {
    profitThresholdToUse = 170; // Default
  }
  
  // console.log(`[Notification] Triggered (force=${force}, inputThreshold=${threshold}, effectiveThreshold=${profitThresholdToUse}, isMarketHours=${marketHours}, type=${type})`);

  if (!force && !marketHours) {
    return { status: 'skipped', reason: 'outside_market_hours' };
  }

  try {
    const userIds = ['PM', 'PDM', 'PSM'];
    const result = await getDashboardAssetAllocation(supabase, userIds);
    
    const equityRows = result.rows.filter(r => r.assetType === 'Stock' || r.assetType === 'ETF');
    
    const stockRows = result.rows.filter(r => r.assetType === 'Stock');
    const etfRows = result.rows.filter(r => r.assetType === 'ETF');

    const stockProfit = stockRows.reduce((sum, r) => sum + r.simpleProfit, 0);
    const stockInvested = stockRows.reduce((sum, r) => sum + r.investedValue, 0);
    const stockProfitPercent = stockInvested > 0 ? (stockProfit / stockInvested) * 100 : 0;

    const etfProfit = etfRows.reduce((sum, r) => sum + r.simpleProfit, 0);
    const etfInvested = etfRows.reduce((sum, r) => sum + r.investedValue, 0);
    const etfProfitPercent = etfInvested > 0 ? (etfProfit / etfInvested) * 100 : 0;

    const totalMarketValue = equityRows.reduce((sum, r) => sum + r.marketValue, 0);
    const totalInvested = equityRows.reduce((sum, r) => sum + r.investedValue, 0);
    const totalProfit = totalMarketValue - totalInvested;
    const profitPercent = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;
    
    const overallDayChange = equityRows.reduce((sum, r) => sum + r.dayChange, 0);
    const dayChangePercent = (totalMarketValue - overallDayChange) > 0 
      ? (overallDayChange / (totalMarketValue - overallDayChange)) * 100 
      : 0;

    const currentValues = { 
      profit: Math.round(totalProfit), 
      change: Math.round(overallDayChange) 
    };

    // Helper to process skip/pause logic for a specific service
    const shouldSkipService = (serviceType) => {
      if (force) return false;
      
      const state = notificationState[serviceType];
      if (state.isPausedDueToSameValues) return true;
      
      const lastValues = state.lastSentValues;
      const isSameAsLast = lastValues.length > 0 && 
                           lastValues[lastValues.length - 1].profit === currentValues.profit && 
                           lastValues[lastValues.length - 1].change === currentValues.change;

      if (isSameAsLast) {
        state.lastSentValues.push(currentValues);
        if (state.lastSentValues.length >= 3) {
          state.isPausedDueToSameValues = true;
        }
        return true; // Skip this one (2nd and 3rd time)
      } else {
        state.lastSentValues = [currentValues];
        state.isPausedDueToSameValues = false;
        return false;
      }
    };

    const skipMobile = (type === 'all' || type === 'mobile') ? shouldSkipService('mobile') : true;
    const skipTelegram = (type === 'all' || type === 'telegram') ? shouldSkipService('telegram') : true;

    if (skipMobile && skipTelegram && !force) {
      return { status: 'skipped', reason: 'paused_or_no_change_all_services' };
    }

    // Aggregate regular stocks by name to check combined profit threshold
    const regularStocksMap = new Map();
    (result.stockHoldings || []).forEach(h => {
      // Only include 'REGULAR' account types (case-insensitive)
      const accountType = (h.accountType || '').toUpperCase();
      
      if (accountType === 'REGULAR') {
        const existing = regularStocksMap.get(h.stockName) || { 
          invested: 0, 
          marketValue: 0, 
          quantity: 0, 
          cmp: 0,
          accounts: new Set()
        };
        
        const invested = toNumber(h.invested);
        const marketValue = toNumber(h.marketValue);
        const quantity = toNumber(h.quantity);
        
        regularStocksMap.set(h.stockName, {
          invested: existing.invested + invested,
          marketValue: existing.marketValue + marketValue,
          quantity: existing.quantity + quantity,
          cmp: h.cmp, // CMP is consistent for same stock name
          accounts: h.accountName ? existing.accounts.add(h.accountName) && existing.accounts : existing.accounts
        });
      }
    });

    const highProfitRegularStocks = [];
    const highProfitByAccountCombination = new Map();

    regularStocksMap.forEach((values, stockName) => {
      const combinedProfitPercent = values.invested > 0 
        ? ((values.marketValue - values.invested) / values.invested) * 100 
        : 0;
      
      const avgBuyPrice = values.quantity > 0 ? values.invested / values.quantity : 0;
      
      // Use >= for inclusive check
      if (combinedProfitPercent >= profitThresholdToUse) {
        const sortedAccounts = Array.from(values.accounts).sort();
        const accountKey = sortedAccounts.join(' & ') || 'Other';
        
        const stockInfo = {
          stockName,
          profitPercent: combinedProfitPercent,
          cmp: values.cmp,
          avgBuyPrice
        };
        
        const stocksForAccount = highProfitByAccountCombination.get(accountKey) || [];
        stocksForAccount.push(stockInfo);
        highProfitByAccountCombination.set(accountKey, stocksForAccount);
        
        highProfitRegularStocks.push(stockInfo);
      }
    });

    highProfitRegularStocks.sort((a, b) => b.profitPercent - a.profitPercent);

    // Sort account combinations to have some deterministic order, maybe by number of stocks or alphabetically
    const sortedAccountKeys = Array.from(highProfitByAccountCombination.keys()).sort();

    // Build notification body
    let mobileBody = `P&L: ₹${totalProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${profitPercent.toFixed(0)}%) | Day: ₹${overallDayChange.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${dayChangePercent.toFixed(0)}%)`;
    mobileBody += `\nStocks : ${stockProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${stockProfitPercent.toFixed(1)}%) II ETF: ${etfProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${etfProfitPercent.toFixed(1)}%)`;

    let telegramBody = `P&L: ₹${totalProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${profitPercent.toFixed(0)}%) | Day: ₹${overallDayChange.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${dayChangePercent.toFixed(0)}%)`;
    telegramBody += `\nStocks : ${stockProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${stockProfitPercent.toFixed(1)}%) II ETF: ${etfProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${etfProfitPercent.toFixed(1)}%)`;

    if (highProfitRegularStocks.length > 0) {
      const highProfitHeader = `\n🔥 High Profit% (${highProfitRegularStocks.length}):`;
      mobileBody += highProfitHeader;
      telegramBody += `\n\n${highProfitHeader.trim()}`;
      
      sortedAccountKeys.forEach(accountKey => {
        const stocks = highProfitByAccountCombination.get(accountKey);
        // Sort stocks within account grouping by profit percent
        stocks.sort((a, b) => b.profitPercent - a.profitPercent);
        
        mobileBody += `\nAccount Name ${accountKey}`;
        telegramBody += `\n\nAccount Name ${accountKey}`;
        
        stocks.forEach(s => {
          const line = `\n• ${s.stockName}: ${s.profitPercent.toFixed(0)}% (C:${s.cmp.toFixed(0)}, A:${s.avgBuyPrice.toFixed(0)})`;
          mobileBody += line;
          telegramBody += line;
        });
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
        const actionHeader = '\n⚡ Action Today:';
        mobileBody += actionHeader;
        telegramBody += `\n\n<b>${actionHeader.trim()}</b>`;
        
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
          const line = `\n• ${a.stock_name}: ${a.type} (${a.ratio})`;
          mobileBody += line;
          telegramBody += line;
        });
      }
    } catch (e) {
      console.error('[Notification] Error fetching bonus actions:', e);
    }

    const payload = {
      title: 'Portfolio Update',
      body: mobileBody,
      icon: '/mainphoto.png',
      badge: '/logo192.png',
      data: {
        url: '/'
      }
    };

    const telegramPayload = {
      ...payload,
      body: telegramBody
    };

    // Send notifications in parallel based on type
    const notificationPromises = [];
    
    if ((type === 'all' || type === 'mobile') && !skipMobile) {
      notificationPromises.push(sendPushNotification(payload));
    }
    
    if ((type === 'all' || type === 'telegram') && notificationState.isTelegramEnabled !== false && !skipTelegram) {
      notificationPromises.push(sendTelegramAlert(telegramPayload));
    }

    const results = await Promise.allSettled(notificationPromises);

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

    // Refresh settings before sending status notification
    await fetchNotificationSettings();

    // Send notifications in parallel
    const notificationPromises = [sendPushNotification(payload)];
    if (notificationState.isTelegramEnabled !== false) {
      notificationPromises.push(sendTelegramAlert(payload));
    }

    const results = await Promise.allSettled(notificationPromises);

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
