import cron from 'node-cron';
import { fetchNSEIndices } from './scraper.js';
import { updateGoogleSheet } from './sheetUpdater.js';

/**
 * Market Hours Check (IST: 9:15 AM - 3:30 PM, Mon-Fri)
 */
export function isMarketOpen() {
  const now = new Date();
  
  // Create formatter for IST
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "long",
  });

  const parts = formatter.formatToParts(now);
  const timeParts = {};
  parts.forEach(({ type, value }) => (timeParts[type] = value));

  const day = timeParts.weekday;
  const hour = parseInt(timeParts.hour);
  const minute = parseInt(timeParts.minute);

  const isWeekday = !["Saturday", "Sunday"].includes(day);
  const totalMinutes = hour * 60 + minute;
  const startMinutes = 9 * 60 + 15; // 09:15
  const endMinutes = 15 * 60 + 30;  // 15:30

  return isWeekday && totalMinutes >= startMinutes && totalMinutes <= endMinutes;
}

export async function runManualUpdate() {
  console.log(`🚀 [NSE Scheduler] Starting NSE index update job at ${new Date().toISOString()}`);
  try {
    const data = await fetchNSEIndices();
    if (Object.keys(data).length > 0) {
      await updateGoogleSheet(data);
      console.log("✅ [NSE Scheduler] Job completed successfully.");
      return { status: 'success', data };
    } else {
      console.log("⚠ [NSE Scheduler] No data fetched from NSE.");
      return { status: 'no-data' };
    }
  } catch (err) {
    console.error("❌ [NSE Scheduler] Job failed:", err.message);
    throw err;
  }
}

export function initNSEIndexUpdater() {
  console.log("⏳ [NSE Scheduler] Initializing NSE Index Updater scheduler...");
  
  // Schedule every 10 minutes: */10 * * * *
  cron.schedule("*/10 * * * *", async () => {
    console.log(`⏳ [NSE Scheduler] Cron triggered at: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} IST`);
    
    if (isMarketOpen()) {
      try {
        await runManualUpdate();
      } catch (err) {
        // Errors are logged in runManualUpdate
      }
    } else {
      console.log("⏸ [NSE Scheduler] Skipping: Market is CLOSED.");
    }
  });

  // Optional: Run an initial check on startup if market is open
  if (isMarketOpen()) {
    console.log("🚀 [NSE Scheduler] Market is currently OPEN. Running initial startup update...");
    runManualUpdate().catch(() => {});
  } else {
    console.log("😴 [NSE Scheduler] Market is CLOSED. Scheduler is waiting for next window.");
  }
}
