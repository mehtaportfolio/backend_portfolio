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
    // For now, use hardcoded user ID - in production, extract from JWT
    const userId = 'test-user';
    const result = await getDashboardAssetAllocation(supabase, userId);
    const { totalProfit, profitPercent, overallDayChange, totalMarketValue } = result.summary;

    const dayChangePercent = (totalMarketValue - overallDayChange) > 0 
      ? (overallDayChange / (totalMarketValue - overallDayChange)) * 100 
      : 0;

    const payload = {
      title: 'Portfolio Update',
      body: `Profit: ₹${totalProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${profitPercent.toFixed(2)}%)\nDay: ₹${overallDayChange.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${dayChangePercent.toFixed(2)}%)`,
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
