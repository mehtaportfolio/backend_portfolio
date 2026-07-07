import { SmartAPI } from 'smartapi-javascript';
import { authenticator } from 'otplib';
import cron from 'node-cron';
import axios from 'axios';
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows, insertRows, updateRows, deleteRows, upsertRows } from '../db/queries.js';

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

export let sessionData = null;
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
        const { error: deleteError } = await deleteRows(supabase, 'stock_symbols', (q) => q.neq('name', '___NON_EXISTENT_NAME___'));

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
        const { error: insertError } = await insertRows(supabase, 'stock_symbols', formatted);
        if (insertError) {
            log(`Error inserting stock symbols: ${insertError.message}`, 'ERROR');
            throw insertError;
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
        
        const { fetchAllRows } = await import('../db/queries.js');

        // 1. Get symbol_ao and stock_name from mappings
        const { data: mapping, error: mappingError } = await fetchAllRows(supabase, 'stock_mapping', {
            select: 'symbol_ao, stock_name',
            filters: [(q) => q.not('symbol_ao', 'is', null)]
        });

        if (mappingError) throw mappingError;
        if (!mapping || mapping.length === 0) {
            log("No active stock mappings found.");
            return;
        }

        // Map symbol_ao to array of stock_names (since multiple stock_names can map to same symbol_ao)
        const symbolAOToStockNamesMap = new Map();
        mapping.forEach(m => {
            if (!symbolAOToStockNamesMap.has(m.symbol_ao)) {
                symbolAOToStockNamesMap.set(m.symbol_ao, []);
            }
            symbolAOToStockNamesMap.get(m.symbol_ao).push(m.stock_name);
        });

        const activeSymbolAOs = Array.from(symbolAOToStockNamesMap.keys());
        
        // 2. Lookup tokens
        const { data: symbols, error: symbolsError } = await fetchAllRows(supabase, 'stock_symbols', {
            select: 'name, exchange, symbol_token',
            filters: [(q) => q.in('name', activeSymbolAOs)]
        });

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
        const upsertMap = new Map();

        fetchedData.forEach(stock => {
            const key = `${stock.exchange}:${stock.symbolToken}`;
            const symbolAO = tokenToSymbolAOMap.get(key);
            if (symbolAO) {
                const stockNames = symbolAOToStockNamesMap.get(symbolAO) || [];
                stockNames.forEach(stockName => {
                    upsertMap.set(stockName, {
                        stock_name: stockName,
                        symbol_ao: symbolAO,
                        cmp: stock.ltp,
                        lcp: stock.close,
                        last_updated: istNow
                    });
                });
            }
        });

        const upsertData = Array.from(upsertMap.values());

        if (upsertData.length > 0) {
            const { error: upsertError } = await upsertRows(supabase, 'stock_mapping', upsertData, { onConflict: 'stock_name' });
            if (upsertError) {
                log(`Error upserting market data: ${upsertError.message}`, 'ERROR');
                throw upsertError;
            }
            log(`Market Data Sync Complete: ${upsertData.length} rows updated.`);
        }

    } catch (error) {
        log(`Error in syncMarketData: ${error.message}`, 'ERROR');
        if (error.message.includes('Token expired') || error.message === 'Invalid Token' || error.errorcode === 'AG8001') {
            sessionData = null;
        }
    }
}

/**
 * Fetch and store today's net open positions from order book
 */
export async function fetchTodayBuyTrades() {
    ensureSmartApi();
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) {
            return { success: false, message: loginResult.message || 'Angel One login failed' };
        }
    }

    try {
        log("Fetching today's order book...");
        const response = await smartApi.getOrderBook();

        if (!response.status) {
            log(`Orderbook API failed: ${response.message}`, 'ERROR');
            if (response.message === 'Invalid Token' || response.message.includes('Token expired') || response.errorcode === 'AG8001') {
                sessionData = null;
            }
            return { success: false, message: response.message || 'Order book fetch failed' };
        }

        const orders = response.data || [];
        if (orders.length === 0) {
            log("No orders found for today.");
            return {
                success: true,
                message: "No orders found for today",
                orders: [],
                formatted: [],
                inserted: 0,
                updated: 0,
                today: new Date().toISOString().split("T")[0]
            };
        }

        const today = new Date().toISOString().split("T")[0];
        const todayOrders = orders.filter((order) => {
            const txnType = String(order.transactiontype || order.transactionType || '').toUpperCase();
            if (!['BUY', 'SELL'].includes(txnType)) return false;

            const ts = order.orderdate || order.orderdatetime || order.filltime || order.filltime || order.datetime || order.updatedtime;
            if (!ts) return false;

            try {
                return new Date(ts).toISOString().split('T')[0] === today;
            } catch (err) {
                return false;
            }
        });

        const isCompletedOrder = (order) => {
            const status = String(order.status || '').toUpperCase();
            return status === 'COMPLETE' || status === 'FILLED' || status === 'TRADED' || status === 'EXECUTED' || status === 'VALIDATED' || status === '';
        };

        const lotBuckets = new Map();
        const clientId = process.env.ANGEL_CLIENT_ID;

        todayOrders.forEach((order) => {
            if (!isCompletedOrder(order)) return;

            const symbol = order.tradingsymbol || order.tradingSymbol || order.symbol || order.symbolname || '';
            const qty = Number(order.quantity || order.fillsize || order.fillquantity || order.orderquantity || 0);
            const price = Number(order.averageprice || order.fillprice || order.price || order.avgprice || 0);
            const txnType = String(order.transactiontype || order.transactionType || '').toUpperCase();

            if (!symbol || qty <= 0) return;

            const bucket = lotBuckets.get(symbol) || [];

            if (txnType === 'BUY') {
                bucket.push({ qty, price });
            } else if (txnType === 'SELL') {
                let remaining = qty;
                while (remaining > 0 && bucket.length > 0) {
                    const lot = bucket[0];
                    const consumed = Math.min(remaining, lot.qty);
                    lot.qty -= consumed;
                    remaining -= consumed;
                    if (lot.qty <= 0) bucket.shift();
                }
            }

            lotBuckets.set(symbol, bucket);
        });

        const formatted = [];
        for (const [symbol, lots] of lotBuckets.entries()) {
            const remainingQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
            if (remainingQty <= 0) continue;

            const weightedAverage = lots.reduce((sum, lot) => sum + (lot.qty * lot.price), 0) / remainingQty;
            formatted.push({
                broker: "angel",
                account_id: clientId,
                symbol,
                isin: null,
                quantity: Math.round(remainingQty),
                average_price: Number(weightedAverage.toFixed(2)),
                last_price: 0,
                pnl: 0,
                product: 'DELIVERY',
                exchange: 'NSE',
                position_date: today,
                fetched_at: new Date().toISOString()
            });
        }

        // 1. Delete rows with date < today (Requirement 1)
        await deleteRows(supabase, 'equity_positions', (q) => q.lt('position_date', today));

        // 2. Fetch existing today's records for this account to compare (Requirement 2)
        const { data: existingToday } = await fetchAllRows(supabase, 'equity_positions', {
            select: 'symbol, quantity, average_price',
            filters: [
                (q) => q.eq('account_id', clientId),
                (q) => q.eq('position_date', today)
            ]
        });

        const existingMap = new Map(existingToday?.map(r => [r.symbol, r]) || []);

        const dataToInsert = [];
        const dataToUpdate = [];

        formatted.forEach(item => {
            const existing = existingMap.get(item.symbol);
            if (!existing) {
                dataToInsert.push(item);
            } else if (Number(existing.quantity) !== Number(item.quantity) || Number(existing.average_price) !== Number(item.average_price)) {
                dataToUpdate.push(item);
            }
        });

        let insertedCount = 0;
        let updatedCount = 0;

        if (dataToInsert.length > 0) {
            const { error: insertError } = await insertRows(supabase, 'equity_positions', dataToInsert);
            if (insertError) {
                log(`Error inserting trades: ${insertError.message}`, 'ERROR');
            } else {
                log(`✅ Inserted ${dataToInsert.length} new net positions for ${clientId}.`);
                insertedCount = dataToInsert.length;
            }
        }

        if (dataToUpdate.length > 0) {
            for (const item of dataToUpdate) {
                const { error: updateError } = await updateRows(supabase, 'equity_positions', {
                    quantity: item.quantity,
                    average_price: item.average_price
                }, (q) => q.match({
                    account_id: clientId,
                    position_date: today,
                    symbol: item.symbol
                }));

                if (updateError) {
                    log(`Error updating trades: ${updateError.message}`, 'ERROR');
                } else {
                    log(`✅ Updated net position for ${item.symbol} (${clientId}).`);
                    updatedCount++;
                }
            }
        }

        if (dataToInsert.length === 0 && dataToUpdate.length === 0) {
            log(`ℹ️ No new or updated net positions for ${clientId} (all were duplicates).`);
        }

        return {
            success: true,
            orders: todayOrders,
            formatted: formatted,
            inserted: insertedCount,
            updated: updatedCount,
            today: today
        };

    } catch (error) {
        log(`Error in fetchTodayBuyTrades: ${error.message}`, 'ERROR');
        return {
            success: false,
            message: error.message
        };
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
        const { data: existingIndices, error: fetchError } = await fetchAllRows(supabase, 'market_indices', {
            select: 'symbol, stock_name'
        });

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

        const upsertMap = new Map();
        const now = new Date().toISOString();

        fetchedData.forEach(data => {
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

            upsertMap.set(finalSymbol, {
                stock_name: finalName,
                symbol: finalSymbol,
                cmp: data.ltp,
                lcp: data.close,
                updated_at: now
            });
        });

        const upsertData = Array.from(upsertMap.values());

        const { error: upsertError } = await upsertRows(supabase, 'market_indices', upsertData, { onConflict: 'symbol' });

        if (upsertError) throw upsertError;
        
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
        log('Cron: Triggering Buy Trade Sync and Fund Value Fetch');
        try {
            await fetchTodayBuyTrades();
            await fetchAndLogAngelFunds();
        } catch (err) {
            log(`Cron 4 PM Tasks Error: ${err.message}`, 'ERROR');
        }
    }, { timezone: "Asia/Kolkata" });

    log("Angel One Background Service started successfully.");
}

/**
 * Fetches Angel One fund values (RMS) and logs them to bank_transactions
 */
export async function fetchAndLogAngelFunds() {
    ensureSmartApi();
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) {
            log('Fund fetch aborted: Angel One login failed', 'WARN');
            return;
        }
    }

    try {
        log('Fetching Angel One RMS balances...');
        const response = await smartApi.getRMS();

        if (response.status && response.data) {
            const amount = parseFloat(response.data.availablecash || 0);
            const today = new Date().toISOString().split('T')[0];
            const accountName = 'PM'; // Based on user requirements/sample data

            log(`Angel One fund value for ${accountName}: ${amount}`);

            const data = {
                account_name: accountName,
                account_type: 'Demat',
                txn_date: today,
                amount: amount,
                bank_name: 'ANGEL ONE',
                is_adjustment: false,
                note: `Daily automated fund fetch at 4 PM`
            };

            // Insert only if current-month Demat rows are NOT found; otherwise update existing rows.
            // This avoids duplicates and prevents UI flicker.
            const monthStart = new Date(today + 'T00:00:00');
            const nextMonth = new Date(monthStart);
            nextMonth.setMonth(monthStart.getMonth() + 1);

            const monthStartStr = monthStart.toISOString().split('T')[0];
            const nextMonthStr = nextMonth.toISOString().split('T')[0];

            const { data: existingMonthDemat, error: fetchMonthErr } = await fetchAllRows(supabase, 'bank_transactions', {
                select: 'id, account_name, account_type, txn_date, amount, bank_name',
                filters: [
                    (q) => q.eq('account_type', 'Demat'),
                    (q) => q.gte('txn_date', monthStartStr),
                    (q) => q.lt('txn_date', nextMonthStr),
                    // keep it scoped to this broker/name so we don't overwrite other Demat sources
                    (q) => q.eq('bank_name', 'ANGEL ONE'),
                    (q) => q.eq('account_name', accountName)
                ]
            });

            if (fetchMonthErr) throw fetchMonthErr;

            if (!existingMonthDemat || existingMonthDemat.length === 0) {
                const { error: insertError } = await insertRows(supabase, 'bank_transactions', [data]);
                if (insertError) throw insertError;
                log(`Inserted Angel One Demat fund value for ${accountName} (${today})`);
            } else {
                // Update all existing rows in current month for this Demat bucket
                // (If your table design guarantees a single row, this updates that single row.)
                for (const row of existingMonthDemat) {
                    const { error: updateError } = await upsertRows(supabase, 'bank_transactions', {
                        id: row.id,
                        account_name: accountName,
                        account_type: 'Demat',
                        txn_date: today,
                        amount: amount,
                        bank_name: 'ANGEL ONE',
                        is_adjustment: false,
                        note: `Daily automated fund fetch at 4 PM`
                    });
                    if (updateError) throw updateError;
                }
                log(`Updated existing Angel One Demat fund value rows for ${accountName} (${today})`);
            }
        } else {
            log(`Failed to fetch RMS: ${response.message || 'Unknown error'}`, 'ERROR');
        }
    } catch (error) {
        log(`Error fetching/logging Angel One funds: ${error.message}`, 'ERROR');
    }

    // Cleanup logic: delete rows older than 3 months for Demat accounts
    await cleanupOldBankTransactions();
}

/**
 * Deletes bank_transactions rows older than 3 months for Demat accounts
 */
async function cleanupOldBankTransactions() {
    try {
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const dateStr = threeMonthsAgo.toISOString().split('T')[0];

        log(`Cleaning up bank_transactions older than ${dateStr} (3 months) for Demat...`);

        // Keep cleanup scoped to Demat + both known brokers so we don't delete other account_type buckets.
        const { error } = await deleteRows(supabase, 'bank_transactions', (q) => 
            q.lt('txn_date', dateStr)
             .eq('account_type', 'Demat')
             .in('bank_name', ['ANGEL ONE', 'KITE'])
        );

        if (error) throw error;
        log(`Successfully cleaned up old Demat bank_transactions records`);
    } catch (error) {
        log(`Failed to cleanup old bank_transactions: ${error.message}`, 'ERROR');
    }
}


/**
 * Place Buy Order via Angel One
 */
export async function placeBuyOrder(symbol, token, quantity, orderType, price) {
    ensureSmartApi();
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) throw new Error("Angel One login failed");
    }

    try {
        const orderPayload = {
            variety: "NORMAL",
            tradingsymbol: symbol,
            symboltoken: token,
            transactiontype: "BUY",
            exchange: "NSE",
            ordertype: orderType === "MARKET" ? "MARKET" : "LIMIT",
            producttype: "DELIVERY",
            duration: "DAY",
            quantity: quantity
        };

        // For LIMIT orders, set price; for MARKET orders, Angel broker handles it
        if (orderType === "LIMIT") {
            orderPayload.price = price;
        }

        const response = await smartApi.placeOrder(orderPayload);

        if (response.status && response.data) {
            return {
                success: true,
                order_id: response.data.orderid
            };
        } else {
            throw new Error(response.message || "Failed to place order in Angel One");
        }
    } catch (error) {
        log(`Angel One placeBuyOrder error: ${error.message}`, 'ERROR');
        throw error;
    }
}

/**
 * Place Sell Order via Angel One
 */
export async function placeSellOrder(symbol, token, quantity, price) {
    ensureSmartApi();
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) throw new Error("Angel One login failed");
    }

    try {
        const response = await smartApi.placeOrder({
            variety: "NORMAL",
            tradingsymbol: symbol,
            symboltoken: token,
            transactiontype: "SELL",
            exchange: "NSE",
            ordertype: "LIMIT",
            producttype: "DELIVERY",
            duration: "DAY",
            price: price,
            quantity: quantity
        });

        if (response.status && response.data) {
            return {
                success: true,
                order_id: response.data.orderid
            };
        } else {
            throw new Error(response.message || "Failed to place order in Angel One");
        }
    } catch (error) {
        log(`Angel One placeOrder error: ${error.message}`, 'ERROR');
        throw error;
    }
}

/**
 * Get Order Status from Angel One
 */
export async function getOrderStatus(orderId) {
    ensureSmartApi();
    if (!sessionData) {
        const loginResult = await login();
        if (!loginResult.success) throw new Error("Angel One login failed");
    }

    try {
        const response = await smartApi.getOrderBook();
        if (response.status && response.data) {
            const order = response.data.find(o => o.orderid === orderId);
            if (!order) throw new Error("Order not found in orderbook");

            return {
                status: order.status, // completed, rejected, open, cancelled
                average_price: order.averageprice,
                filled_quantity: order.filledshares,
                status_message: order.text
            };
        } else {
            throw new Error(response.message || "Failed to fetch orderbook from Angel One");
        }
    } catch (error) {
        log(`Angel One getOrderStatus error: ${error.message}`, 'ERROR');
        throw error;
    }
}
