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

  // If no suffix, try common Indian suffixes
  if (!baseYahoo.includes(".")) {
    variants.push(baseYahoo + ".NS");
    variants.push(baseYahoo + ".BO");
  }

  // SME alternative
  if (baseYahoo.endsWith(".NS")) variants.push(baseYahoo.replace(".NS", "-SM.NS"));
  if (baseYahoo.endsWith(".BO")) variants.push(baseYahoo.replace(".BO", "-SM.BO"));
  
  // Also try -SM for those we just added
  if (!baseYahoo.includes(".")) {
    variants.push(baseYahoo + "-SM.NS");
    variants.push(baseYahoo + "-SM.BO");
  }

  // Try switching NSE/BSE if first fails
  if (baseYahoo.endsWith(".NS")) variants.push(baseYahoo.replace(".NS", ".BO"));
  if (baseYahoo.endsWith(".BO")) variants.push(baseYahoo.replace(".BO", ".NS"));

  return [...new Set(variants)]; // Unique variants
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

    const batchSize = 50; // Smaller batch size to be safe and avoid rate limits
    let totalUpdated = 0;
    let zeroValues = 0;
    const failedSymbols = [];

    // Process in batches
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      console.log(`⚡ [YahooPriceFix] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(stocks.length / batchSize)}`);

      for (const stock of batch) {
        const dbSymbol = stock.symbol;
        const stockName = stock.stock_name || null;
        let yfData = null;
        let lastError = null;

        const variants = generateYahooVariants(dbSymbol);

        // Try each variant until valid CMP is found
        for (const sym of variants) {
          try {
            yfData = await yf.quote(sym);
            if (yfData && yfData.regularMarketPrice != null) break;
          } catch (err) {
            lastError = err.message;
            // Silently fail for variants, common to have 404s
          }
        }

        if (!yfData || yfData.regularMarketPrice == null) {
          console.log(`❌ [YahooPriceFix] Failed ${dbSymbol} after trying all variants. Last error: ${lastError}`);
          failedSymbols.push({ symbol: dbSymbol, name: stockName });
        } else {
          const cmpVal = yfData.regularMarketPrice ?? 0;
          const lcpVal = yfData.regularMarketPreviousClose ?? 0;

          if (cmpVal === 0 || lcpVal === 0) {
            zeroValues++;
          }

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
        }

        // Small delay between each stock to be very gentle
        await new Promise(resolve => setTimeout(resolve, 200));
      }

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
