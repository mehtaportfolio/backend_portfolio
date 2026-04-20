import { runNSEActions } from './nseService.js';
import { runBSEActions } from './bseService.js';
import { runYahooActions } from './yahooService.js';

/**
 * Main orchestrator for Corporate Action background service.
 * Fetches and updates corporate actions from NSE, BSE, and Yahoo.
 */
export async function startCorpActionService() {
  const startTime = Date.now();
  console.log("\n🔔 [Corporate Action Service] Starting Master Sync...");

  try {
    // Run scrapers in sequence to manage load
    console.log("\n📡 --- NSE Scraper ---");
    await runNSEActions();
  } catch (err) {
    console.error("❌ NSE Scraper failed:", err.message);
  }

  try {
    console.log("\n📡 --- BSE Scraper ---");
    await runBSEActions();
  } catch (err) {
    console.error("❌ BSE Scraper failed:", err.message);
  }

  try {
    console.log("\n📡 --- Yahoo Scraper ---");
    await runYahooActions();
  } catch (err) {
    console.error("❌ Yahoo Scraper failed:", err.message);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✅ [Corporate Action Service] Master Sync Finished in ${duration}s\n`);
}
