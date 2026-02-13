// test-notification.js
import { triggerPortfolioUpdate } from './backend/src/services/notificationService.js';
import { syncStocks } from './syncStocks.js';
import 'dotenv/config'; // Add this at the very top of test-notification.js


async function test() {
  console.log("🚀 Starting manual notification test...");
  
  try {
    // Force trigger (skips market hours check)
    const result = await triggerPortfolioUpdate(true);
    
    console.log("✅ Notification Payload Generated:");
    console.log(JSON.stringify(result.data, null, 2));
    
    if (result.status === 'sent') {
      console.log("\n🔔 Notification sent to all subscribers successfully.");
    }
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

test();
