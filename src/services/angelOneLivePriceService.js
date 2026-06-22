import { supabase } from '../db/supabaseClient.js';
import { login, sessionData, smartApi, ensureSmartApi } from './angelOneService.js';

let priceUpdateInterval = null;
let marketHoursCheckInterval = null;
let isUpdating = false;

/**
 * Get market hours check times
 * Market open: 9:15 AM IST (Monday-Friday)
 * Market close: 3:30 PM IST (Monday-Friday)
 */
function isMarketOpen() {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  
  const dayOfWeek = istTime.getDay();
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  const timeInMinutes = hours * 60 + minutes;
  
  // Monday (1) to Friday (5)
  if (dayOfWeek < 1 || dayOfWeek > 5) {
    return false; // Weekend
  }
  
  // Market hours: 9:15 AM (555 minutes) to 3:30 PM (930 minutes)
  const marketOpenTime = 9 * 60 + 15;  // 555
  const marketCloseTime = 15 * 60 + 30; // 930
  
  return timeInMinutes >= marketOpenTime && timeInMinutes <= marketCloseTime;
}

/**
 * Get all unique symbols and their tokens from equity_positions
 */
async function getSymbolTokens() {
  try {
    const { data, error } = await supabase
      .from('equity_positions')
      .select('symbol');

    if (error) {
      console.error('[LivePrice] Error fetching symbols:', error.message);
      return [];
    }

    const symbols = [...new Set((data || []).map(p => p.symbol))];
    
    if (symbols.length === 0) {
      return [];
    }

    // Get symbol_token for all symbols
    const { data: stockData, error: stockError } = await supabase
      .from('stock_master')
      .select('symbol, symbol_token')
      .in('symbol', symbols);

    if (stockError) {
      console.error('[LivePrice] Error fetching symbol tokens:', stockError.message);
      return [];
    }

    const tokens = (stockData || [])
      .filter(s => s.symbol_token)
      .map(s => ({
        symbol: s.symbol,
        token: s.symbol_token.trim()
      }));

    return tokens;
  } catch (err) {
    console.error('[LivePrice] getSymbolTokens error:', err.message);
    return [];
  }
}

/**
 * Fetch live prices from Angel One API
 */
async function fetchLivePrices() {
  if (isUpdating) {
    return;
  }

  isUpdating = true;

  try {
    // Ensure we have a session
    if (!sessionData || !sessionData.jwtToken) {
      const loginResult = await login();
      if (!loginResult.success) {
        isUpdating = false;
        return;
      }
    }

    ensureSmartApi();

    // Get all symbols to fetch
    const symbolTokens = await getSymbolTokens();
    if (symbolTokens.length === 0) {
      isUpdating = false;
      return;
    }

    // Fetch prices in chunks (Angel One has limits)
    const CHUNK_SIZE = 50;
    const nseTokens = symbolTokens.map(st => st.token);
    
    let updatedCount = 0;

    for (let i = 0; i < nseTokens.length; i += CHUNK_SIZE) {
      const chunk = nseTokens.slice(i, i + CHUNK_SIZE);
      
      try {
        const response = await smartApi.marketData({
          mode: 'FULL',
          exchangeTokens: { 'NSE': chunk }
        });

        if (response.status && response.data && response.data.fetched) {
          const fetched = response.data.fetched;

          // Update database with prices
          for (const priceData of fetched) {
            const token = priceData.tk || priceData.token;
            const ltp = priceData.ltp || priceData.lastPrice;

            if (token && ltp) {
              // Find symbol from token
              const symbolInfo = symbolTokens.find(st => st.token === String(token));
              if (symbolInfo) {
                await updatePrice(symbolInfo.symbol, ltp);
                updatedCount++;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[LivePrice] Error fetching chunk:`, err.message);
      }
    }

    if (updatedCount > 0) {
      console.log(`[LivePrice] Updated ${updatedCount} positions`);
    }
  } catch (err) {
    console.error('[LivePrice] fetchLivePrices error:', err.message);
  } finally {
    isUpdating = false;
  }
}

/**
 * Update last_price in equity_positions for a symbol
 */
async function updatePrice(symbol, lastPrice) {
  try {
    const { error } = await supabase
      .from('equity_positions')
      .update({ last_price: lastPrice })
      .eq('symbol', symbol);

    if (error) {
      console.error(`[LivePrice] Error updating price for ${symbol}:`, error.message);
    }
  } catch (err) {
    console.error(`[LivePrice] updatePrice error for ${symbol}:`, err.message);
  }
}

/**
 * Update all positions with closing price when market closes
 */
async function updateClosingPrices() {
  try {
    console.log('[LivePrice] Updating positions with closing prices...');

    const { data: positions, error: posError } = await supabase
      .from('equity_positions')
      .select('symbol');

    if (posError) {
      console.error('[LivePrice] Error fetching positions for closing:', posError.message);
      return;
    }

    const symbols = [...new Set((positions || []).map(p => p.symbol))];

    if (symbols.length === 0) {
      return;
    }

    // Get closing prices (LCP) from stock_master
    const { data: stockData, error: stockError } = await supabase
      .from('stock_master')
      .select('symbol, lcp')
      .in('symbol', symbols);

    if (stockError) {
      console.error('[LivePrice] Error fetching closing prices:', stockError.message);
      return;
    }

    // Update each symbol with its LCP
    let closedCount = 0;
    for (const stock of stockData || []) {
      if (stock.lcp) {
        await updatePrice(stock.symbol, stock.lcp);
        closedCount++;
      }
    }

    console.log(`[LivePrice] Market closed - updated ${closedCount} positions with LCP`);
  } catch (err) {
    console.error('[LivePrice] updateClosingPrices error:', err.message);
  }
}

/**
 * Initialize live price service with polling
 */
export async function initializeLivePriceService() {
  try {
    console.log('[LivePrice] Initializing Angel One live price service (polling mode)...');

    // Check market hours every minute and update prices every 5 seconds during market hours
    marketHoursCheckInterval = setInterval(async () => {
      const open = isMarketOpen();

      if (open) {
        // During market hours: fetch prices every 5 seconds
        if (!priceUpdateInterval) {
          console.log('[LivePrice] Market open, starting price polling (every 5 seconds)...');
          
          // Fetch immediately
          await fetchLivePrices();
          
          // Then set interval for subsequent updates
          priceUpdateInterval = setInterval(fetchLivePrices, 5000); // 5 seconds
        }
      } else {
        // Market closed: stop polling and update with closing prices
        if (priceUpdateInterval) {
          console.log('[LivePrice] Market closed, stopping polling...');
          clearInterval(priceUpdateInterval);
          priceUpdateInterval = null;
          
          // Update with closing prices once
          await updateClosingPrices();
        }
      }
    }, 60000); // Check every minute

    // Initial check
    if (isMarketOpen()) {
      console.log('[LivePrice] Market is open, starting price updates...');
      await fetchLivePrices();
      priceUpdateInterval = setInterval(fetchLivePrices, 5000);
    } else {
      console.log('[LivePrice] Market is closed, will start polling at market open');
    }
  } catch (err) {
    console.error('[LivePrice] initializeLivePriceService error:', err.message);
  }
}

/**
 * Stop live price service
 */
export function stopLivePriceService() {
  if (priceUpdateInterval) {
    clearInterval(priceUpdateInterval);
    priceUpdateInterval = null;
  }
  if (marketHoursCheckInterval) {
    clearInterval(marketHoursCheckInterval);
    marketHoursCheckInterval = null;
  }
  console.log('[LivePrice] Service stopped');
}

export default { initializeLivePriceService, stopLivePriceService };
