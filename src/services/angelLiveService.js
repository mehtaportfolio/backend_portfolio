import { SmartAPI, WebSocketV2 } from "smartapi-javascript";
import { authenticator } from 'otplib';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows } from '../db/queries.js';
import { isMarketHours } from './angelOneService.js';

let sessionData = null;
let smartWS = null;
let lastTicks = {};
let wss = null;
let clients = new Set();
let tokenToSymbolMap = {};
let isLoggingIn = false;

// --- LOGIN ---
export async function loginToAngel() {
  if (isLoggingIn) return;
  
  if (!isMarketHours()) {
    console.log("[Angel] Skipping login: Outside market hours (9:15 AM - 3:30 PM IST)");
    return null;
  }

  isLoggingIn = true;
  
  try {
    const apiKey = (process.env.ANGEL_API_KEY || '').trim();
    const clientId = (process.env.ANGEL_CLIENT_ID || '').trim().toUpperCase();
    const password = (process.env.ANGEL_PASSWORD || '').trim();
    const totpSecret = (process.env.ANGEL_TOTP_SECRET || '').trim();

    if (!apiKey || !clientId || !password || !totpSecret) {
      console.error("❌ Angel One credentials missing in .env.backend");
      isLoggingIn = false;
      return null;
    }

    const smartApi = new SmartAPI({ api_key: apiKey });
    
    // Clean TOTP secret and generate OTP using authenticator (designed for Base32 secrets)
    const cleanSecret = totpSecret.replace(/\s/g, '').toUpperCase();
    const otp = authenticator.generate(cleanSecret);

    const response = await smartApi.generateSession(clientId, password, otp);

    if (!response.status || !response.data) {
      console.error("❌ Angel One login failed:", response.message || "Unknown error");
      isLoggingIn = false;
      return null;
    }

    sessionData = response.data;

    // Start Angel WebSocket after successful login
    startAngelWS();
    
    isLoggingIn = false;
    return sessionData;
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
  sessionData = null;
}

async function startAngelWS() {
  if (!sessionData) return;

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
  const jwtToken = sessionData.jwtToken;
  const feedToken = sessionData.feedToken;

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
    // Get unique stock names using paginated helper
    const { data: txns, error: txnError } = await fetchAllRows(supabase, 'stock_transactions', {
      select: 'stock_name'
    });

    if (txnError) throw txnError;
    
    const uniqueStockNames = [...new Set(txns.map(t => t.stock_name))];
    
    if (uniqueStockNames.length === 0) {
      return;
    }

    // Map to symbols and tokens using paginated helper
    const { data: symbols, error: symError } = await fetchAllRows(supabase, 'stock_symbols', {
      select: 'name, symbol_token, exchange',
      filters: [q => q.in('name', uniqueStockNames)]
    });

    if (symError) throw symError;

    const tokenList = [];
    const exchangeMap = {
      'NSE': 1,
      'BSE': 3
    };

    symbols.forEach(s => {
      const exchangeType = exchangeMap[s.exchange] || 1;
      const token = s.symbol_token.toString();
      
      tokenToSymbolMap[token] = s.name;
      
      let entry = tokenList.find(t => t.exchangeType === exchangeType);
      if (!entry) {
        entry = { exchangeType, tokens: [] };
        tokenList.push(entry);
      }
      entry.tokens.push(token);
    });

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
function handleTick(msg) {
  try {
    if (!msg || !msg.token) return;
    
    const rawToken = msg.token.toString().replace(/"/g, '');
    const symbol = tokenToSymbolMap[rawToken] || rawToken;
    
    const tick = {
      symbol,
      ltp: parseFloat(msg.last_traded_price) / 100
    };

    lastTicks[symbol] = tick;
    broadcast(tick);

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
    if (!sessionData && !isLoggingIn) {
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

  return wss;
}
