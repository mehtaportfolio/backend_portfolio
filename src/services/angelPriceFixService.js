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
        const { fetchAllRows } = await import('../db/queries.js');
        const { data: tradedStocks, error: txnError } = await fetchAllRows(supabase, "stock_transactions", {
            select: "stock_name"
        });

        if (txnError) {
            log(`Error fetching traded stocks: ${txnError.message}`, 'ERROR');
            return { status: 'error', message: txnError.message };
        }

        const uniqueTradedNames = [...new Set(tradedStocks.map(t => t.stock_name?.trim().toUpperCase()))].filter(Boolean);
        log(`Found ${uniqueTradedNames.length} unique traded stocks in transactions.`);

        if (uniqueTradedNames.length === 0) {
            log("No traded stocks found to update.");
            return { status: 'success', message: "No traded stocks found." };
        }

        // 2. Fetch all rows from stock_master to check what we have
        const { data: allMaster, error: masterFetchError } = await fetchAllRows(supabase, "stock_master", {
            select: "symbol, stock_name, cmp, lcp"
        });

        if (masterFetchError) {
            log(`Error fetching from stock_master: ${masterFetchError.message}`, 'ERROR');
            return { status: 'error', message: masterFetchError.message };
        }
        
        log(`Fetched ${allMaster.length} total records from stock_master.`);

        // Helper to check if a traded name exists in master (either as stock_name or part of symbol)
        const getMasterMatch = (name) => {
            const upName = name.trim().toUpperCase();
            return allMaster.find(m => {
                const mName = m.stock_name?.trim().toUpperCase();
                const mSymbol = m.symbol?.trim().toUpperCase();
                return mName === upName || 
                       mSymbol === `NSE:${upName}` ||
                       mSymbol === `BSE:${upName}` ||
                       mSymbol === `BOM:${upName}` ||
                       mSymbol === upName;
            });
        };

        const missingTradedFromMaster = uniqueTradedNames.filter(name => !getMasterMatch(name));

        if (missingTradedFromMaster.length > 0) {
            log(`Found ${missingTradedFromMaster.length} traded stocks missing from stock_master entirely. Attempting to auto-populate...`);
            
            // Fetch details from stock_symbols for these missing names
            const { data: symbolsForMissing, error: symbolsFetchError } = await fetchAllRows(supabase, "stock_symbols", {
                select: "name, exchange",
                filters: [(q) => q.in("name", missingTradedFromMaster)]
            });

            if (!symbolsFetchError && symbolsForMissing && symbolsForMissing.length > 0) {
                // Deduplicate by name, prioritize NSE
                const uniqueToInsert = new Map();
                symbolsForMissing.forEach(s => {
                    const normalizedName = s.name.trim().toUpperCase();
                    const existing = uniqueToInsert.get(normalizedName);
                    
                    // If doesn't exist, or if current is NSE and existing is BSE
                    if (!existing || (s.exchange === 'NSE' && existing.exchange === 'BSE')) {
                        uniqueToInsert.set(normalizedName, {
                            name: s.name,
                            exchange: s.exchange,
                            symbol: `${s.exchange}:${s.name}`
                        });
                    }
                });

                const insertData = [];
                for (const [name, info] of uniqueToInsert) {
                    // One last check against live allMaster to be absolutely sure
                    if (!getMasterMatch(name)) {
                        insertData.push({
                            stock_name: info.name,
                            symbol: info.symbol,
                            cmp: 0,
                            lcp: 0,
                            updated_at: new Date().toISOString()
                        });
                    }
                }
                if (insertData.length > 0) {
                    log(`Attempting to insert ${insertData.length} stocks. First few: ${JSON.stringify(insertData.slice(0, 3))}`);
                    const { error: insertError } = await supabase
                        .from("stock_master")
                        .insert(insertData);
                    
                    if (insertError) {
                        log(`Failed to auto-populate stock_master: ${insertError.message}`, 'ERROR');
                    } else {
                        log(`✅ Auto-populated ${insertData.length} stocks into stock_master.`);
                        // Refresh our local allMaster list (re-fetch all to be safe)
                        const { data: rMasterPage } = await fetchAllRows(supabase, "stock_master", {
                            select: "symbol, stock_name, cmp, lcp"
                        });
                        
                        if (rMasterPage && rMasterPage.length > 0) {
                            allMaster.length = 0;
                            allMaster.push(...rMasterPage);
                        }
                    }
                }
            }
        }

        // 3. Identify which of our traded stocks have missing CMP/LCP in the updated master list
        const stocksToFix = uniqueTradedNames
            .map(name => getMasterMatch(name))
            .filter(match => match && (match.cmp === null || match.cmp === 0 || match.lcp === null || match.lcp === 0));

        if (!stocksToFix || stocksToFix.length === 0) {
            log("All traded stocks have valid CMP/LCP in master table.");
            return { status: 'success', message: "No missing stocks for traded entities found." };
        }

        log(`Found ${stocksToFix.length} traded stocks missing CMP/LCP in master table.`);

        // 3. Map stock names to Angel One tokens
        const stockNamesToFind = stocksToFix.map(s => s.stock_name);
        const { data: symbolData, error: symbolError } = await fetchAllRows(supabase, "stock_symbols", {
            select: "name, exchange, symbol_token",
            filters: [(q) => q.in("name", stockNamesToFind)]
        });

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
            totalMissingInMaster: missingTradedFromMaster.length,
            missingTradedFound: stocksToFix.length,
            tokensFound: symbolData.length,
            updatedCount: updateCount
        };

    } catch (err) {
        log(`Unexpected error: ${err.message}`, 'ERROR');
        return { status: 'error', message: err.message };
    }
}
