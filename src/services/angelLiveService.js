import { SmartAPI, WebSocketV2 } from "smartapi-javascript";
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows } from '../db/queries.js';
import { isMarketHours, login as angelLogin, sessionData as angelSession } from './angelOneService.js';

let smartWS = null;
let lastTicks = {};
let wss = null;
let clients = new Set();
let tokenToSymbolMap = {};
let equityPositionSymbols = new Set();
let isLoggingIn = false;

async function refreshEquityPositionSymbols() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'equity_positions', {
      select: 'symbol'
    });

    if (error) {
      console.error('[Angel] Error refreshing equity position symbols:', error.message);
      return;
    }

    equityPositionSymbols = new Set((data || [])
      .map(row => row.symbol)
      .filter(Boolean));
    try {
      // Debug sample
      const sample = Array.from(equityPositionSymbols).slice(0, 10);
      console.log(`[Angel] Refreshed equityPositionSymbols (${equityPositionSymbols.size}) sample:`, sample);
    } catch (e) {}
  } catch (err) {
    console.error('[Angel] refreshEquityPositionSymbols error:', err.message);
  }
}

async function getEquityPositionTokens() {
  try {
    const { data: positions, error: positionError } = await supabase
      .from('equity_positions')
      .select('symbol, exchange');

    if (positionError) {
      console.error('[Angel] Error fetching equity positions:', positionError.message);
      return [];
    }

    const uniquePositions = Array.from(new Map(
      (positions || [])
        .filter((row) => row.symbol)
        .map((row) => [row.symbol.trim(), row])
    ).values());

    if (uniquePositions.length === 0) {
      return [];
    }

    const symbols = uniquePositions.map((row) => row.symbol.trim());

    // Query `stock_master` for tokens matching stock_name.
    // We normalize exchange values later, because stock_master may store null or lowercase exchange names.
    const tokenRows = [];
    try {
      const { data: byName, error: byNameErr } = await supabase
        .from('stock_master')
        .select('stock_name, symbol_token, exchange, symbol')
        .in('stock_name', symbols);
      if (byNameErr) {
        console.error('[Angel] Error fetching from stock_master by stock_name:', byNameErr.message);
      } else if (byName && byName.length) {
        tokenRows.push(...byName);
      }
    } catch (e) {
      console.error('[Angel] Error querying stock_master for tokens:', e.message || e);
      return [];
    }

    // Deduplicate by stock_name + exchange
    const seen = new Set();
    const uniqueTokenRows = (tokenRows || []).filter(r => {
      if (!r || !r.stock_name) return false;
      const key = `${(r.stock_name || '').toString().trim()}|${(r.exchange || 'NSE').toString().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const tokenMap = new Map();
    uniqueTokenRows
      .filter((row) => row.stock_name && row.symbol_token)
      .forEach((row) => {
        const stockNameKey = row.stock_name.trim();
        const exchangeKey = ((row.exchange || 'NSE').toString().trim() || 'NSE').toUpperCase();
        const tokenData = { token: row.symbol_token.toString().trim(), exchange: exchangeKey };

        tokenMap.set(`${stockNameKey}|${exchangeKey}`, tokenData);
        tokenMap.set(stockNameKey, tokenData);
      });

    // Debug: log how many tokens were found vs requested
    try {
      const requested = symbols.slice(0, 20);
      const found = uniqueTokenRows.map(r => `${r.stock_name}|${r.exchange}`).slice(0, 20);
      console.log(`[Angel] getEquityPositionTokens: requested ${symbols.length}, found ${uniqueTokenRows?.length || 0} in stock_master`);
      console.log('[Angel] requested sample:', requested);
      console.log('[Angel] found sample (from stock_master):', found);
    } catch (e) {}

    return uniquePositions
      .map((row) => {
        const exchangeKey = ((row.exchange || 'NSE').toString().trim() || 'NSE').toUpperCase();
        const symbolData = tokenMap.get(`${row.symbol.trim()}|${exchangeKey}`) || tokenMap.get(row.symbol.trim());
        return {
          symbol: row.symbol,
          token: symbolData?.token,
          exchange: row.exchange || symbolData?.exchange || 'NSE'
        };
      })
      .filter((item) => item.token);
  } catch (err) {
    console.error('[Angel] getEquityPositionTokens error:', err.message);
    return [];
  }
}

// --- LOGIN ---
export async function loginToAngel() {
  if (isLoggingIn) return;
  
  if (!isMarketHours()) {
    console.log("[Angel] Skipping login: Outside market hours (9:15 AM - 3:30 PM IST)");
    return null;
  }

  isLoggingIn = true;
  
  try {
    console.log("[Angel] Requesting login from AngelOneService...");
    const result = await angelLogin();

    if (!result.success || !angelSession) {
      console.error("❌ Angel One login failed via AngelOneService");
      isLoggingIn = false;
      return null;
    }

    // Start Angel WebSocket after successful login
    startAngelWS();
    
    isLoggingIn = false;
    return angelSession;
  } catch (err) {
    console.error("❌ Angel One login error:", err.message);
    isLoggingIn = false;
    return null;
  }
}

// --- ANGEL WEBSOCKET ---
export function stopAngelWS() {
  if (smartWS) {
    console.log("[Angel] Closing WebSocket connection (Market Hours Ended)");
    try {
      smartWS.close();
    } catch (e) {
      console.error("[Angel] Error closing WebSocket:", e.message);
    }
    smartWS = null;
  }
}

async function startAngelWS() {
  if (!angelSession) return;

  if (!isMarketHours()) {
    console.log("[Angel] Skipping WebSocket start: Outside market hours");
    return;
  }

  // Cleanup previous instance before reconnecting
  if (smartWS) {
    try {
      smartWS.close();
    } catch (e) {}
    smartWS = null;
  }

  const clientId = process.env.ANGEL_CLIENT_ID;
  const apiKey = process.env.ANGEL_API_KEY;
  const jwtToken = angelSession.jwtToken;
  const feedToken = angelSession.feedToken;

  if (!jwtToken || !feedToken) {
    console.error("❌ JWT or FeedToken missing. Cannot start Angel WebSocket.");
    return;
  }

  smartWS = new WebSocketV2({
    clientcode: clientId,
    jwttoken: jwtToken,
    apikey: apiKey,
    feedtype: feedToken
  });

  smartWS.connect().then(async () => {
    // Refresh the in-memory list of equity position symbols
    await refreshEquityPositionSymbols();

    // Add 1s delay to ensure SDK state is synchronized
    setTimeout(async () => {
      await subscribeToPortfolioStocks();
    }, 1000);
    
  }).catch(err => {
    console.error("❌ Angel WS connection error:", err);
    setTimeout(startAngelWS, 5000);
  });

  smartWS.on("tick", handleTick);

  smartWS.on("message", (data) => {
    try {
      const msg = typeof data === "string" ? JSON.parse(data) : data;
      handleTick(msg);
    } catch (e) {}
  });

  smartWS.on("close", () => {
    setTimeout(startAngelWS, 5000);
  });

  smartWS.on("error", (err) => {
    console.error("❌ Angel WS Error:", err);
  });
}

// --- PORTFOLIO SUBSCRIPTION ---
async function subscribeToPortfolioStocks() {
  if (!smartWS) {
    return;
  }

  try {
    // Subscribe only to symbols currently present in equity_positions
    const symbolTokens = await getEquityPositionTokens();

    if (symbolTokens.length === 0) {
      console.warn('[Angel] No equity position symbols found for subscription.');
      return;
    }

    const tokenList = [];
    const exchangeMap = {
      'NSE': 1,
      'BSE': 3
    };

    symbolTokens.forEach(s => {
      const exchangeType = exchangeMap[s.exchange] || 1;
      const token = s.token;

      tokenToSymbolMap[token] = s.symbol;

      let entry = tokenList.find(t => t.exchangeType === exchangeType);
      if (!entry) {
        entry = { exchangeType, tokens: [] };
        tokenList.push(entry);
      }
      entry.tokens.push(token);
    });

    try {
      const mapSampleKeys = Object.keys(tokenToSymbolMap).slice(0, 10);
      console.log(`[Angel] subscribeToPortfolioStocks: built tokenToSymbolMap (${Object.keys(tokenToSymbolMap).length}) sample tokens:`, mapSampleKeys);
    } catch (e) {}

    if (tokenList.length === 0) {
      console.warn("[Angel] No matching tokens found for subscription.");
      return;
    }

    // Chunking logic: Angel One V2 has a limit (around 50 per call)
    const CHUNK_SIZE = 50;
    const DELAY = 200; // 200ms delay between chunks

    tokenList.forEach(item => {
      // Deduplicate tokens before subscription
      item.tokens = [...new Set(item.tokens)];
      
      for (let i = 0; i < item.tokens.length; i += CHUNK_SIZE) {
        const chunk = item.tokens.slice(i, i + CHUNK_SIZE);
        
        setTimeout(() => {
          if (!smartWS) return;
          
          const params = {
            correlationID: `portfolio_sync_${Date.now()}_${i}`,
            action: 1, // Subscribe
            mode: 3,   // Full mode
            tokenList: [
              {
                exchangeType: item.exchangeType,
                tokens: chunk
              }
            ]
          };

          // Detect the correct method (V2 usually uses subscribe, but some versions use fetchData)
          if (typeof smartWS.subscribe === 'function') {
            smartWS.subscribe(params);
          } else if (typeof smartWS.fetchData === 'function') {
            smartWS.fetchData({
              ...params,
              exchangeType: item.exchangeType,
              tokens: chunk
            });
          } else {
            console.error("❌ Angel WebSocket method not found (no subscribe or fetchData)");
          }
        }, i * (DELAY / CHUNK_SIZE)); // Spread out the delay based on chunk index
      }
    });

  } catch (err) {
    console.error("❌ Error subscribing to stocks:", err.message);
  }
}

// --- TICK HANDLING ---
async function updateEquityPositionLastPrice(symbol, lastPrice) {
  try {
    if (!equityPositionSymbols.has(symbol)) {
      return;
    }

    // Update open positions for this symbol (quantity > 0)
    const { error } = await supabase
      .from('equity_positions')
      .update({ last_price: lastPrice })
      .eq('symbol', symbol)
      .gt('quantity', 0);

    if (error) {
      console.error(`[Angel] Failed updating equity_positions.last_price for ${symbol}:`, error.message);
    }
  } catch (err) {
    console.error(`[Angel] Error updating equity_positions.last_price for ${symbol}:`, err.message);
  }
}

function handleTick(msg) {
  try {
    if (!msg || !msg.token) return;
    
    const rawToken = msg.token.toString().replace(/"/g, '');
    const symbol = tokenToSymbolMap[rawToken] || rawToken;
    
    const tick = {
      symbol,
      ltp: parseFloat(msg.last_traded_price) / 100
    };

    const previousTick = lastTicks[symbol];
    lastTicks[symbol] = tick;
    broadcast(tick);

    if (!previousTick || previousTick.ltp !== tick.ltp) {
      // Debug: if token didn't map to a symbol or symbol not in equity positions
      if (!tokenToSymbolMap[rawToken]) {
        console.warn(`[Angel] Received tick for unmapped token ${rawToken} (ltp=${tick.ltp}).`);
      }
      if (!equityPositionSymbols.has(symbol)) {
        // symbol might be raw token or in different format
        console.warn(`[Angel] Tick symbol '${symbol}' not found in equityPositionSymbols set (${equityPositionSymbols.size}).`);
      }

      updateEquityPositionLastPrice(symbol, tick.ltp);
    }

  } catch (err) {
    console.error("❌ Error processing tick:", err.message);
  }
}

// --- BROADCAST ---
function broadcast(tick) {
  clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      // If client has subscribed to specific symbols, filter
      if (!client.symbols || client.symbols.includes(tick.symbol)) {
        client.send(JSON.stringify(tick));
      }
    }
  });
}

// --- CLIENT WEBSOCKET SERVER ---
export function initLivePriceServer(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname === '/ws/live-prices') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Initial check if we need to login (only if market is open)
    if (!angelSession && !isLoggingIn) {
      if (isMarketHours()) {
        loginToAngel();
      } else {
        console.log("[Angel] Live price requested outside market hours. Skipping login.");
      }
    }

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === "subscribe") {
          ws.symbols = data.symbols;
          
          // Send cached ticks immediately
          ws.symbols.forEach(symbol => {
            if (lastTicks[symbol]) {
              ws.send(JSON.stringify(lastTicks[symbol]));
            }
          });
        }
      } catch (err) {
        console.error("❌ Error handling client message:", err.message);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
    
    ws.on("error", (err) => {
      console.error("❌ Client WebSocket error:", err.message);
    });
  });

  // Schedule stop at 3:31 PM IST (Monday to Friday)
  cron.schedule('31 15 * * 1-5', () => {
    console.log("⏰ [Cron] Market hours ended. Stopping Angel One Live prices...");
    stopAngelWS();
  }, { timezone: "Asia/Kolkata" });

  // Schedule start at 9:15 AM IST (Monday to Friday)
  cron.schedule('15 9 * * 1-5', () => {
    console.log("⏰ [Cron] Market hours started. Checking Angel One Live prices...");
    if (angelSession) {
      if (!smartWS) {
        console.log("[Angel] Session exists, starting WebSocket...");
        startAngelWS();
      }
    } else if (!isLoggingIn) {
      console.log("[Angel] Session missing, logging in...");
      loginToAngel();
    }
  }, { timezone: "Asia/Kolkata" });

  // Periodic check during market hours to ensure we are connected (Every 5 mins)
  cron.schedule('*/5 9-15 * * 1-5', () => {
    if (isMarketHours()) {
      if (angelSession) {
        if (!smartWS) {
          console.log("⏰ [Cron] Market is open, session exists but WebSocket missing. Starting...");
          startAngelWS();
        }
      } else if (!isLoggingIn) {
        console.log("⏰ [Cron] Market is open but Angel session missing. Retrying login...");
        loginToAngel();
      }
    }
  }, { timezone: "Asia/Kolkata" });

  return wss;
}

export async function refreshAngelPositionSubscriptions() {
  try {
    await refreshEquityPositionSymbols();
    await subscribeToPortfolioStocks();
    console.log('[Angel] Refreshed live subscriptions after equity positions update');
  } catch (err) {
    console.error('[Angel] refreshAngelPositionSubscriptions error:', err.message);
  }
}
