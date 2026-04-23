import { SmartAPI } from 'smartapi-javascript';
import { authenticator } from 'otplib';
import cron from 'node-cron';
import axios from 'axios';
import { supabase } from '../db/supabaseClient.js';

const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

export let smartApi = null;

/**
 * Ensure smartApi is initialized
 */
function ensureSmartApi() {
    if (!smartApi) {
        smartApi = new SmartAPI({
            api_key: (process.env.ANGEL_API_KEY || '').trim(),
        });
    }
}

let sessionData = null;
let isLoggingIn = false;
let loginPromise = null;

/**
 * Log message with timestamp
 */
function log(message, type = 'INFO') {
    const istTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    if (type === 'DEBUG' && process.env.NODE_ENV === 'production') return;
    console.log(`[${istTime}] [AngelOneService] [${type}] ${message}`);
}

/**
 * Check if current time is within Indian Stock Market hours (9:15 AM - 3:30 PM IST, Mon-Fri)
 */
export function isMarketHours() {
    const istTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    const marketOpen = 9 * 60 + 15; // 9:15 AM
    const marketClose = 15 * 60 + 30; // 3:30 PM

    // Monday to Friday
    return day >= 1 && day <= 5 && timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
}

/**
 * Login to Angel One
 */
export async function login() {
    ensureSmartApi();
    if (isLoggingIn && loginPromise) {
        log('Login already in progress, awaiting existing promise...');
        return loginPromise;
    }
    
    isLoggingIn = true;
    loginPromise = (async () => {
        try {
            const clientId = (process.env.ANGEL_CLIENT_ID || '').trim().toUpperCase();
            const password = (process.env.ANGEL_PASSWORD || '').trim();
            const totpSecret = (process.env.ANGEL_TOTP_SECRET || '').trim().replace(/\s/g, '').toUpperCase();

            if (!clientId || !password || !totpSecret) {
                log('Credentials missing in environment variables', 'ERROR');
                return { success: false, message: 'Credentials missing' };
            }

            const otp = authenticator.generate(totpSecret);
            log(`Attempting login for ${clientId} with API Key: ${smartApi.api_key}...`);

            const response = await smartApi.generateSession(clientId, password, otp);

            if (response.status && response.data) {
                sessionData = response.data;
                
                // Explicitly set tokens on the instance to ensure subsequent calls have them
                smartApi.jwtToken = sessionData.jwtToken;
                smartApi.feedToken = sessionData.feedToken;
                
                log('Login successful. Session updated and tokens set.');
                return { success: true };
            } else {
                const errorMsg = response.message || 'Empty response message';
                const errorCode = response.errorcode || 'No error code';
                log(`Login failed: ${errorMsg} (Code: ${errorCode})`, 'ERROR');
                log(`Full Response: ${JSON.stringify(response)}`, 'DEBUG');
                return { success: false, message: errorMsg };
            }
        } catch (error) {
            log(`Login error: ${error.message}`, 'ERROR');
            return { success: false, message: error.message };
        } finally {
            isLoggingIn = false;
            loginPromise = null;
        }
    })();

    return loginPromise;
}

/**
 * Fetch and sync stock symbols from Angel One master list
 */
export async function refreshStockSymbols() {
    try {
        log("Downloading Angel One instrument master...");
        const response = await axios.get(MASTER_URL, { timeout: 60000 });
        const instruments = response.data;

        if (!Array.isArray(instruments)) {
            throw new Error("Invalid master data received");
        }

        log(`Total instruments downloaded: ${instruments.length}`);

        // 1. Clean existing records
        log("Cleaning stock_symbols table...");
        const { error: deleteError } = await supabase
            .from('stock_symbols')
            .delete()
            .neq('name', '___NON_EXISTENT_NAME___'); // Correct way to delete all

        if (deleteError) throw deleteError;

        // 2. Filter NSE/BSE and deduplicate
        const filtered = instruments.filter(item => 
            item.exch_seg === "NSE" || item.exch_seg === "BSE"
        );

        log(`Processing ${filtered.length} NSE/BSE instruments...`);

        const uniqueMap = new Map();
        
        // Sort: BSE first, then NSE so NSE overwrites BSE if duplicates exist for same name
        const sortedFiltered = filtered.sort((a, b) => {
            if (a.exch_seg === "BSE" && b.exch_seg === "NSE") return -1;
            if (a.exch_seg === "NSE" && b.exch_seg === "BSE") return 1;
            return 0;
        });

        sortedFiltered.forEach(item => {
            if (item.name) {
                uniqueMap.set(item.name, {
                    symbol: item.symbol,
                    name: item.name,
                    exchange: item.exch_seg,
                    symbol_token: item.token
                });
            }
        });

        const formatted = Array.from(uniqueMap.values());
        log(`Unique instruments to insert: ${formatted.length}`);

        // 3. Batch insert
        const batchSize = 2000;
        for (let i = 0; i < formatted.length; i += batchSize) {
            const batch = formatted.slice(i, i + batchSize);
            const { error } = await supabase.from('stock_symbols').insert(batch);
            if (error) {
                log(`Batch insert error at index ${i}: ${error.message}`, 'ERROR');
            }
            if (i % 10000 === 0 && i > 0) {
                log(`Inserted ${i} instruments...`);
            }
        }

        log("✅ Stock symbols sync completed.");
        return { success: true, count: formatted.length };

    } catch (error) {
        log(`Error refreshing stock symbols: ${error.message}`, 'ERROR');
        throw error;
    }
}

/**
 * Helper to fetch market data in chunks
 */
async function fetchMarketDataChunked(exchangeTokens) {
    ensureSmartApi();
    const CHUNK_SIZE = 50;
    const allFetchedData = [];
    const exchanges = Object.keys(exchangeTokens);

    for (const exch of exchanges) {
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
                    const msg = response.message || 'Unknown error';
                    log(`Market data chunk error for ${exch}: ${msg}`, 'WARN');
                    if (msg === 'Invalid Token' || msg.includes('Token expired') || response.errorcode === 'AG8001') {
                        sessionData = null;
                        throw new Error(msg);
                    }
                }
            } catch (err) {
                log(`Exception in fetchMarketDataChunked for ${exch}: ${err.message}`, 'ERROR');
                if (err.message === 'Invalid Token' || err.message.includes('Token expired')) {
                    throw err;
                }
            }
        }
    }
    return allFetchedData;
}

/**
 * Sync Market Data (CMP & LCP)
 */
export async function syncMarketData() {
    if (!sessionData) {
        log('Session missing. Attempting login...');
        const loginResult = await login();
        if (!loginResult.success) {
            log('Sync aborted: Login failed', 'WARN');
            return;
        }
    }

    try {
        log('Starting Market Data Sync...');
        
        // 1. Get symbol_ao from mappings
        const { data: mapping, error: mappingError } = await supabase
            .from('stock_mapping')
            .select('symbol_ao')
            .not('symbol_ao', 'is', null);

        if (mappingError) throw mappingError;
        if (!mapping || mapping.length === 0) {
            log("No active stock mappings found.");
            return;
        }

        const activeSymbolAOs = mapping.map(m => m.symbol_ao);
        
        // 2. Lookup tokens
        const { data: symbols, error: symbolsError } = await supabase
            .from('stock_symbols')
            .select('name, exchange, symbol_token')
            .in('name', activeSymbolAOs);

        if (symbolsError) throw symbolsError;
        if (!symbols || symbols.length === 0) {
            log("No matching tokens found in stock_symbols.");
            return;
        }

        const tokenToSymbolAOMap = new Map();
        const exchangeTokens = {};

        symbols.forEach(s => {
            if (s.exchange && s.symbol_token && s.name) {
                const key = `${s.exchange}:${s.symbol_token}`;
                tokenToSymbolAOMap.set(key, s.name);

                if (!exchangeTokens[s.exchange]) exchangeTokens[s.exchange] = [];
                exchangeTokens[s.exchange].push(s.symbol_token);
            }
        });

        // 3. Fetch Market Data
        const fetchedData = await fetchMarketDataChunked(exchangeTokens);
        const fetchedKeys = new Set(fetchedData.map(stock => `${stock.exchange}:${stock.symbolToken}`));
        
        console.log(`Fetched ${fetchedData.length} records from API (expected ${symbols.length}).`);

        // Identify missing stocks
        const missingFromAPI = [];
        tokenToSymbolAOMap.forEach((symbolAO, key) => {
            if (!fetchedKeys.has(key)) {
                missingFromAPI.push(symbolAO);
            }
        });

        if (missingFromAPI.length > 0) {
            log(`Missing from API response: ${missingFromAPI.join(', ')}`, 'WARN');
        }

        if (fetchedData.length === 0) {
            log("No market data fetched from Angel API.", 'WARN');
            return;
        }

        // 4. Update mappings
        const istNow = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
        let updateCount = 0;

        const updatePromises = fetchedData.map(async (stock) => {
            const key = `${stock.exchange}:${stock.symbolToken}`;
            const symbolAO = tokenToSymbolAOMap.get(key);

            if (symbolAO) {
                const { error } = await supabase
                    .from('stock_mapping')
                    .update({
                        cmp: stock.ltp,
                        lcp: stock.close,
                        last_updated: istNow
                    })
                    .eq('symbol_ao', symbolAO);

                if (!error) updateCount++;
            }
        });

        await Promise.all(updatePromises);
        log(`Market Data Sync Complete: ${updateCount} rows updated.`);

    } catch (error) {
        log(`Error in syncMarketData: ${error.message}`, 'ERROR');
        if (error.message.includes('Token expired') || error.message === 'Invalid Token' || error.errorcode === 'AG8001') {
            sessionData = null;
        }
    }
}

/**
 * Fetch and store today's buy trades
 */
export async function fetchTodayBuyTrades() {
    ensureSmartApi();
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) return;
    }

    try {
        log("Fetching today's tradebook...");
        const response = await smartApi.getTradeBook();

        if (!response.status) {
            log(`Tradebook API failed: ${response.message}`, 'ERROR');
            if (response.message === 'Invalid Token' || response.message.includes('Token expired') || response.errorcode === 'AG8001') {
                sessionData = null;
            }
            return;
        }

        const trades = response.data || [];
        if (trades.length === 0) {
            log("No trades found for today.");
            return;
        }

        // Aggregate buy trades
        const grouped = {};
        const clientId = process.env.ANGEL_CLIENT_ID;

        trades.forEach(t => {
            if (t.transactiontype !== "BUY") return;

            const symbol = t.tradingsymbol || t.tradingSymbol || t.symbol;
            const exchange = t.exchange || t.exch_seg;
            const key = `${symbol}_${exchange}`;

            if (!grouped[key]) {
                grouped[key] = {
                    symbol: symbol,
                    exchange: exchange,
                    isin: t.isin || null,
                    product: t.producttype || t.product,
                    totalQty: 0,
                    totalValue: 0
                };
            }

            const qty = Number(t.quantity || t.fillsize || t.fillquantity || 0);
            const price = Number(t.price || t.fillprice || t.averageprice || 0);

            if (!isNaN(qty) && !isNaN(price)) {
                grouped[key].totalQty += qty;
                grouped[key].totalValue += qty * price;
            }
        });

        const formatted = Object.values(grouped).map(g => ({
            broker: "angel",
            account_id: clientId,
            symbol: g.symbol,
            isin: g.isin,
            quantity: g.totalQty,
            average_price: g.totalQty > 0 ? Number((g.totalValue / g.totalQty).toFixed(2)) : 0,
            last_price: 0,
            pnl: 0,
            product: g.product,
            exchange: g.exchange,
            position_date: new Date().toISOString().split("T")[0],
            fetched_at: new Date().toISOString()
        }));

        if (formatted.length === 0) {
            log("No BUY trades to aggregate.");
            return;
        }

        const today = new Date().toISOString().split("T")[0];

        // 1. Delete rows with date < today (Requirement 1)
        // irrespective of account_id or anything else
        await supabase
            .from('equity_positions')
            .delete()
            .lt('position_date', today);

        // 2. Fetch existing today's records for this account to avoid duplicates (Requirement 2)
        const { data: existingToday } = await supabase
            .from('equity_positions')
            .select('symbol')
            .eq('account_id', clientId)
            .eq('position_date', today);

        const existingSymbols = new Set(existingToday?.map(r => r.symbol) || []);

        const dataToInsert = formatted.filter(item => !existingSymbols.has(item.symbol));

        if (dataToInsert.length > 0) {
            const { error } = await supabase.from('equity_positions').insert(dataToInsert);

            if (error) {
                log(`Error inserting trades: ${error.message}`, 'ERROR');
            } else {
                log(`✅ Inserted ${dataToInsert.length} new aggregated BUY trades for ${clientId}.`);
            }
        } else {
            log(`ℹ️ No new trades to insert for ${clientId} (all were duplicates).`);
        }

    } catch (error) {
        log(`Error in fetchTodayBuyTrades: ${error.message}`, 'ERROR');
    }
}

/**
 * Sync Market Indices (Nifty, Sensex, etc.)
 */
export async function syncMarketIndices() {
    if (!sessionData) {
        log('Session missing for Index sync. Attempting login...');
        const loginResult = await login();
        if (!loginResult.success) {
            log('Index sync aborted: Login failed', 'WARN');
            return;
        }
    }

    try {
        log('Starting Market Indices Sync...');
        
        // 1. Fetch existing indices for matching
        const { data: existingIndices, error: fetchError } = await supabase
            .from('market_indices')
            .select('symbol, stock_name');

        if (fetchError) {
            log(`Warning: Failed to fetch existing indices: ${fetchError.message}`, 'WARN');
        }

        const indices = [
            { name: 'Nifty 50', symbol: 'NIFTY', token: '99926000', exchange: 'NSE' },
            { name: 'Sensex', symbol: 'SENSEX', token: '99919000', exchange: 'BSE' },
            { name: 'NIFTY MIDCAP 100', symbol: 'NIFTY MIDCAP 100', token: '99926011', exchange: 'NSE' },
            { name: 'NIFTY SMALLCAP 250', symbol: 'NIFTY SMLCAP 250', token: '99926062', exchange: 'NSE' }
        ];

        const exchangeTokens = {};
        indices.forEach(idx => {
            if (!exchangeTokens[idx.exchange]) exchangeTokens[idx.exchange] = [];
            exchangeTokens[idx.exchange].push(idx.token);
        });

        const fetchedData = await fetchMarketDataChunked(exchangeTokens);
        
        if (fetchedData.length === 0) {
            log("No market indices data fetched from Angel API.", 'WARN');
            return;
        }

        const upsertData = fetchedData.map(data => {
            const indexInfo = indices.find(idx => idx.token === data.symbolToken && idx.exchange === data.exchange);
            
            let finalName = indexInfo ? indexInfo.name : data.tradingSymbol;
            let finalSymbol = indexInfo ? indexInfo.symbol : data.tradingSymbol;

            // 2. Perform case-insensitive match on stock_name to avoid duplicates
            if (existingIndices && existingIndices.length > 0) {
                const match = existingIndices.find(ex => 
                    ex.stock_name && finalName && ex.stock_name.toLowerCase() === finalName.toLowerCase()
                );
                if (match) {
                    // Use the existing symbol from the database to trigger an update instead of an insert
                    finalSymbol = match.symbol;
                    finalName = match.stock_name; // Keep existing name formatting
                }
            }

            return {
                stock_name: finalName,
                symbol: finalSymbol,
                cmp: data.ltp,
                lcp: data.close,
                updated_at: new Date().toISOString()
            };
        });

        const { error } = await supabase
            .from('market_indices')
            .upsert(upsertData, { onConflict: 'symbol' });

        if (error) throw error;
        
        log(`Market Indices Sync Complete: ${upsertData.length} indices updated.`);

    } catch (error) {
        log(`Error in syncMarketIndices: ${error.message}`, 'ERROR');
        if (error.message.includes('Token expired') || error.message === 'Invalid Token' || error.errorcode === 'AG8001') {
            sessionData = null;
        }
    }
}

/**
 * Start Angel One background service
 */
export async function startAngelOneService() {
    log("Initializing Angel One Background Service...");

    // 1. Initial login
    const loginResult = await login();
    if (loginResult.success) {
        // Initial syncs (Only during market hours or specific setup)
        if (isMarketHours()) {
            log("Market is open. Performing initial sync...");
            await syncMarketData();
            await syncMarketIndices();
            await fetchTodayBuyTrades();
        } else {
            log("Market is closed. Skipping initial sync on startup.");
        }
    }

    // 2. Schedule Cron Jobs (IST Time)
    
    // Market Data Sync (CMP) - Every 5 minutes (Only during market hours)
    cron.schedule('*/5 * * * *', async () => {
        if (!isMarketHours()) {
            return;
        }
        log('Cron: Triggering Market Data Sync');
        try {
            await syncMarketData();
            await syncMarketIndices();
        } catch (err) {
            log(`Cron Market Data Sync Error: ${err.message}`, 'ERROR');
        }
    }, { timezone: "Asia/Kolkata" });

    // Daily Symbol Refresh - 9:00 AM IST
    cron.schedule('0 9 * * *', async () => {
        log('Cron: Triggering Daily Symbol Refresh');
        try {
            await refreshStockSymbols();
        } catch (err) {
            log(`Cron Symbol Refresh Error: ${err.message}`, 'ERROR');
        }
    }, { timezone: "Asia/Kolkata" });

    // Automated Daily Login - 8:00 AM IST
    cron.schedule('0 8 * * *', async () => {
        log('Cron: Automated Daily Login');
        sessionData = null;
        await login();
    }, { timezone: "Asia/Kolkata" });

    // LCP Sync - 4:30 PM IST (after market close)
    cron.schedule('30 16 * * *', async () => {
        log('Cron: Triggering Daily LCP Sync');
        try {
            await syncMarketData();
        } catch (err) {
            log(`Cron LCP Sync Error: ${err.message}`, 'ERROR');
        }
    }, { timezone: "Asia/Kolkata" });

    // Buy Trade Sync - 4:00 PM IST
    cron.schedule('0 16 * * *', async () => {
        log('Cron: Triggering Buy Trade Sync');
        try {
            await fetchTodayBuyTrades();
        } catch (err) {
            log(`Cron Buy Trade Sync Error: ${err.message}`, 'ERROR');
        }
    }, { timezone: "Asia/Kolkata" });

    log("Angel One Background Service started successfully.");
}
