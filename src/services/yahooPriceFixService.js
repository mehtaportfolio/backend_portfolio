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
    
    // Check for Index patterns (e.g., HDFCSML250 -> ^NSESML250 or similar)
    // HDFCSML250 is often used for Nifty Smallcap 250 Index
    if (baseYahoo.includes("SML250")) variants.push("^NSESML250");
    if (baseYahoo.includes("MID100")) variants.push("^NSEMDCP100");
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

  // If it's still failing and looks like a symbol that might be an index
  if (!baseYahoo.startsWith("^") && baseYahoo.length > 3) {
    variants.push("^" + baseYahoo);
  }

  return [...new Set(variants)]; // Unique variants
}

/**
 * Main Service Function to fill missing CMP/LCP using Yahoo Finance
 */
export async function runYahooPriceFixService() {
  try {
    console.log("🔍 [YahooPriceFix] Starting background service to check missing CMP/LCP...");

    // 1. Get list of unique traded stock names to reduce scope
    const { data: tradedStocks, error: txnError } = await supabase
      .from("stock_transactions")
      .select("stock_name");

    if (txnError) {
      console.error("❌ [YahooPriceFix] Error fetching traded stocks:", txnError.message);
      return { status: 'error', message: txnError.message };
    }

    const uniqueTradedNames = [...new Set(tradedStocks.map(t => t.stock_name))].filter(Boolean);
    console.log(`📊 [YahooPriceFix] Found ${uniqueTradedNames.length} unique traded stocks in transactions.`);

    if (uniqueTradedNames.length === 0) {
      console.log("ℹ️ [YahooPriceFix] No traded stocks found to update.");
      return { status: 'success', message: "No traded stocks found." };
    }

    // 2. Fetch missing rows from stock_master that are in the traded list
    // We check for null, 0, or blank CMP/LCP
    const { data: stocks, error } = await supabase
      .from("stock_master")
      .select("symbol, stock_name")
      .in("stock_name", uniqueTradedNames)
      .or("cmp.is.null,cmp.eq.0,lcp.is.null,lcp.eq.0")
      .limit(1000);

    if (error) {
      console.error("❌ [YahooPriceFix] Error fetching stocks from Supabase:", error.message);
      return { status: 'error', message: error.message };
    }

    if (!stocks || stocks.length === 0) {
      console.log("ℹ️ [YahooPriceFix] No traded stocks found in stock_master with missing CMP/LCP.");
      return { status: 'success', message: "No missing stocks for traded entities found." };
    }

    console.log(`📊 [YahooPriceFix] Found ${stocks.length} traded stocks missing CMP/LCP in master table.`);

    const batchSize = 50; 
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
            
            // Handle 429 Too Many Requests
            if (err.message.includes("429") || err.message.toLowerCase().includes("too many requests")) {
              console.warn(`⚠️ [YahooPriceFix] Rate limited (429) at ${sym}. Waiting 60 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 60000));
              // Retry once for this variant after cooldown
              try {
                yfData = await yf.quote(sym);
                if (yfData && yfData.regularMarketPrice != null) break;
              } catch (retryErr) {
                lastError = retryErr.message;
              }
            }
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

        // Delay between each stock to avoid 429
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Delay between batches
      if (i + batchSize < stocks.length) {
        await new Promise(resolve => setTimeout(resolve, 3000));
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
