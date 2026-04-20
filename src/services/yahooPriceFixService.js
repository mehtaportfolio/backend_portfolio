import YahooFinance from 'yahoo-finance2';
import { supabase } from '../db/supabaseClient.js';

// Create a new instance of YahooFinance with validation disabled to avoid noise
const yf = new YahooFinance({ validation: { logErrors: false } });

/**
 * Convert DB symbol to Yahoo format
 */
function convertToYahoo(symbol) {
  if (!symbol) return null;
  symbol = symbol.trim();
  if (symbol.startsWith("NSE:")) return symbol.replace("NSE:", "").replace(/\./g, "") + ".NS";
  if (symbol.startsWith("BOM:")) return symbol.replace("BOM:", "").replace(/\./g, "") + ".BO";
  return symbol.replace(/\./g, ""); // fallback: remove dots
}

/**
 * Generate possible Yahoo symbol variants for a stock
 */
function generateYahooVariants(dbSymbol) {
  const variants = [];
  const baseYahoo = convertToYahoo(dbSymbol);
  if (!baseYahoo) return variants;

  variants.push(baseYahoo);

  // SME alternative
  if (baseYahoo.endsWith(".NS")) variants.push(baseYahoo.replace(".NS", "-SM.NS"));
  if (baseYahoo.endsWith(".BO")) variants.push(baseYahoo.replace(".BO", "-SM.BO"));

  // Try switching NSE/BSE if first fails
  if (baseYahoo.endsWith(".NS")) variants.push(baseYahoo.replace(".NS", ".BO"));
  if (baseYahoo.endsWith(".BO")) variants.push(baseYahoo.replace(".BO", ".NS"));

  return variants;
}

/**
 * Main Service Function to fill missing CMP/LCP using Yahoo Finance
 */
export async function runYahooPriceFixService() {
  try {
    console.log("🔍 [YahooPriceFix] Starting background service to check missing CMP/LCP...");

    // Fetch missing rows (cmp or lcp null or 0)
    // We limit to 1000 to avoid excessive processing in one go
    const { data: stocks, error } = await supabase
      .from("stock_master")
      .select("symbol, stock_name")
      .or("cmp.is.null,cmp.eq.0,lcp.is.null,lcp.eq.0")
      .limit(1000);

    if (error) {
      console.error("❌ [YahooPriceFix] Error fetching stocks from Supabase:", error.message);
      return { status: 'error', message: error.message };
    }

    if (!stocks || stocks.length === 0) {
      console.log("ℹ️ [YahooPriceFix] No stocks found with missing CMP/LCP.");
      return { status: 'success', message: "No missing stocks found." };
    }

    console.log(`📊 [YahooPriceFix] Found ${stocks.length} stocks missing CMP/LCP`);

    const batchSize = 25; // Smaller batch size to be safe and avoid rate limits
    let totalUpdated = 0;
    let zeroValues = 0;
    const failedSymbols = [];

    // Process in batches
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      console.log(`⚡ [YahooPriceFix] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(stocks.length / batchSize)}`);

      await Promise.all(batch.map(async (stock) => {
        const dbSymbol = stock.symbol;
        const stockName = stock.stock_name || null;
        let yfData = null;

        const variants = generateYahooVariants(dbSymbol);

        // Try each variant until valid CMP is found
        for (const sym of variants) {
          try {
            // Using yf.quote which is standard in yahoo-finance2 v2/v3
            yfData = await yf.quote(sym);
            if (yfData && yfData.regularMarketPrice != null) break;
          } catch (err) {
            // Silently fail for variants, common to have 404s
          }
        }

        if (!yfData || yfData.regularMarketPrice == null) {
          failedSymbols.push({ symbol: dbSymbol, name: stockName });
          return;
        }

        const cmpVal = yfData.regularMarketPrice ?? 0;
        const lcpVal = yfData.regularMarketPreviousClose ?? 0;

        if (cmpVal === 0 || lcpVal === 0) {
          zeroValues++;
        }

        // Only update if we have a valid non-zero CMP to avoid overwriting with 0 if possible
        // but the requirement says only update records where CMP/LCP is missing or zero.
        // If we found a 0 value from Yahoo, we still update if the current value is null/0.
        
        const { error: updateError } = await supabase
          .from("stock_master")
          .update({ 
            cmp: cmpVal, 
            lcp: lcpVal,
            updated_at: new Date().toISOString() 
          })
          .eq("symbol", dbSymbol);

        if (updateError) {
          console.error(`❌ [YahooPriceFix] Failed to update ${dbSymbol}:`, updateError.message);
        } else {
          totalUpdated++;
        }
      }));

      // Add a small delay between batches to respect API rate limits
      if (i + batchSize < stocks.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Summary
    console.log(`✅ [YahooPriceFix] Update completed. Total processed: ${stocks.length}`);
    console.log(`📈 [YahooPriceFix] Successfully updated: ${totalUpdated}`);
    console.log(`⚠️ [YahooPriceFix] Updated with zero values: ${zeroValues}`);
    if (failedSymbols.length > 0) {
      console.log(`❌ [YahooPriceFix] Failed to fetch data for ${failedSymbols.length} symbols.`);
    }

    return {
      status: 'success',
      totalProcessed: stocks.length,
      totalUpdated,
      zeroValues,
      failedCount: failedSymbols.length
    };

  } catch (err) {
    console.error("❌ [YahooPriceFix] Unexpected error in service:", err.message);
    return { status: 'error', message: err.message };
  }
}
