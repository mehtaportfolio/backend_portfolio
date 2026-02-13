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
  
  // Mon-Fri
  if (day === 0 || day === 6) return false;
  
  const timeInMinutes = hours * 60 + minutes;
  const startInMinutes = 9 * 60 + 15;
  const endInMinutes = 15 * 60 + 30;
  
  return timeInMinutes >= startInMinutes && timeInMinutes <= endInMinutes;
};

/**
 * Send push notification to all subscribers
 * @param {object} payload - Notification data
 */
export async function sendPushNotification(payload) {
  try {
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('subscription');

    if (error) throw error;
    if (!subscriptions || subscriptions.length === 0) {
      console.log('No push subscriptions found.');
      return;
    }

    const notificationPayload = JSON.stringify(payload);

    const sendPromises = subscriptions.map((sub) => 
      webpush.sendNotification(sub.subscription, notificationPayload)
        .catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or no longer valid
            console.log('Push subscription expired, removing...');
            return supabase.from('push_subscriptions').delete().match({ subscription: sub.subscription });
          }
          console.error('Error sending push notification:', err);
        })
    );

    await Promise.all(sendPromises);
    console.log(`Push notifications sent to ${subscriptions.length} devices.`);
  } catch (err) {
    console.error('Error in sendPushNotification:', err);
  }
}

/**
 * Trigger portfolio update notification
 * @param {boolean} force - Skip market hours check if true
 */
export async function triggerPortfolioUpdate(force = false) {
  if (!force && !isMarketHours()) {
    console.log('Outside market hours. Skipping notification.');
    return { status: 'skipped', reason: 'outside_market_hours' };
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
      
      if (combinedProfitPercent > 140) {
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
