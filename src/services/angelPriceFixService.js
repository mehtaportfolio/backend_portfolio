import { supabase } from '../db/supabaseClient.js';
import { login, smartApi } from './angelOneService.js';

/**
 * Log message with timestamp
 */
function log(message, type = 'INFO') {
    const istTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`[${istTime}] [AngelPriceFix] [${type}] ${message}`);
}

/**
 * Main Service Function to fill missing CMP/LCP using Angel One
 */
export async function runAngelPriceFixService() {
    try {
        log("🔍 Starting Angel One price fix service...");

        // 1. Get list of unique traded stock names to reduce scope
        const { data: tradedStocks, error: txnError } = await supabase
            .from("stock_transactions")
            .select("stock_name");

        if (txnError) {
            log(`Error fetching traded stocks: ${txnError.message}`, 'ERROR');
            return { status: 'error', message: txnError.message };
        }

        const uniqueTradedNames = [...new Set(tradedStocks.map(t => t.stock_name))].filter(Boolean);
        log(`Found ${uniqueTradedNames.length} unique traded stocks in transactions.`);

        if (uniqueTradedNames.length === 0) {
            log("No traded stocks found to update.");
            return { status: 'success', message: "No traded stocks found." };
        }

        // 2. Fetch missing rows from stock_master that are in the traded list
        // We check for null, 0, or blank CMP/LCP
        const { data: stocksToFix, error: masterError } = await supabase
            .from("stock_master")
            .select("symbol, stock_name")
            .in("stock_name", uniqueTradedNames)
            .or("cmp.is.null,cmp.eq.0,lcp.is.null,lcp.eq.0");

        if (masterError) {
            log(`Error fetching stocks from stock_master: ${masterError.message}`, 'ERROR');
            return { status: 'error', message: masterError.message };
        }

        if (!stocksToFix || stocksToFix.length === 0) {
            log("No traded stocks found in stock_master with missing CMP/LCP.");
            return { status: 'success', message: "No missing stocks for traded entities found." };
        }

        log(`Found ${stocksToFix.length} traded stocks missing CMP/LCP in master table.`);

        // 3. Map stock names to Angel One tokens
        const stockNames = stocksToFix.map(s => s.stock_name);
        const { data: symbolData, error: symbolError } = await supabase
            .from("stock_symbols")
            .select("name, exchange, symbol_token")
            .in("name", stockNames);

        if (symbolError) {
            log(`Error fetching tokens from stock_symbols: ${symbolError.message}`, 'ERROR');
            return { status: 'error', message: symbolError.message };
        }

        // Group tokens by exchange
        const exchangeTokens = {};
        const tokenToStockMap = new Map(); // key: "EXCHANGE:TOKEN", value: stock_name

        symbolData.forEach(s => {
            if (!exchangeTokens[s.exchange]) exchangeTokens[s.exchange] = [];
            exchangeTokens[s.exchange].push(s.symbol_token);
            tokenToStockMap.set(`${s.exchange}:${s.symbol_token}`, s.name);
        });

        if (Object.keys(exchangeTokens).length === 0) {
            log("No matching tokens found in stock_symbols for missing stocks.", 'WARN');
            return { status: 'error', message: "No tokens found" };
        }

        // 4. Login to Angel One
        const loginResult = await login();
        if (!loginResult.success) {
            log("Angel One login failed. Aborting price fix.", 'ERROR');
            return { status: 'error', message: "Login failed" };
        }

        // Initialize smartApi if not done (login() calls ensureSmartApi())
        if (!smartApi) {
             log("smartApi instance missing after login.", 'ERROR');
             return { status: 'error', message: "smartApi missing" };
        }

        log("Fetching market data from Angel One...");
        const allFetchedData = [];
        const CHUNK_SIZE = 50;

        for (const exch of Object.keys(exchangeTokens)) {
            const tokens = exchangeTokens[exch];
            for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
                const chunk = tokens.slice(i, i + CHUNK_SIZE);
                try {
                    const response = await smartApi.marketData({
                        mode: "FULL",
                        exchangeTokens: { [exch]: chunk }
                    });
                    
                    if (response.status && response.data && response.data.fetched) {
                        allFetchedData.push(...response.data.fetched);
                    } else {
                        log(`Market data chunk error for ${exch}: ${response.message || 'Unknown error'}`, 'WARN');
                    }
                    // Small delay to be gentle with API
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (err) {
                    log(`Exception fetching market data for ${exch}: ${err.message}`, 'ERROR');
                }
            }
        }

        if (allFetchedData.length === 0) {
            log("No market data fetched from Angel API.", 'WARN');
            return { status: 'error', message: "No market data fetched" };
        }

        log(`Fetched ${allFetchedData.length} records. Updating stock_master...`);

        // 5. Update stock_master
        let updateCount = 0;
        const istNow = new Date().toISOString();

        for (const data of allFetchedData) {
            const stockName = tokenToStockMap.get(`${data.exchange}:${data.symbolToken}`);
            if (stockName) {
                const { error: updateError } = await supabase
                    .from("stock_master")
                    .update({
                        cmp: data.ltp,
                        lcp: data.close,
                        updated_at: istNow
                    })
                    .eq("stock_name", stockName);

                if (updateError) {
                    log(`Failed to update ${stockName}: ${updateError.message}`, 'ERROR');
                } else {
                    updateCount++;
                }
            }
        }

        log(`✅ Angel One Price Fix Complete: ${updateCount} rows updated.`);
        return {
            status: 'success',
            totalTraded: uniqueTradedNames.length,
            missingFound: stocksToFix.length,
            tokensFound: symbolData.length,
            updatedCount: updateCount
        };

    } catch (err) {
        log(`Unexpected error: ${err.message}`, 'ERROR');
        return { status: 'error', message: err.message };
    }
}
