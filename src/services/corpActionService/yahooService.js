import { supabase } from '../../db/supabaseClient.js';
import { fetchAllRows } from '../../db/queries.js';
import YahooFinance from 'yahoo-finance2';

// Create a new instance of YahooFinance
const yf = new YahooFinance({ validation: { logErrors: false } });

function getDateRange(days = 30) {
  const today = new Date();
  const lastDate = new Date();
  lastDate.setDate(today.getDate() - days);
  const format = d => d.toISOString().split("T")[0]; // YYYY-MM-DD
  return { from: format(lastDate), to: format(today) };
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  return dateStr.split("T")[0]; // YYYY-MM-DD
}

async function getSymbolsFromTransactions() {
  try {
    const { data: transData, error: transError } = await fetchAllRows(supabase, "stock_transactions", {
      select: "stock_name",
      filters: [(q) => q.is("sell_date", null)]
    });

    if (transError) {
      console.error("❌ Error fetching transactions for Yahoo:", transError.message);
      return {};
    }

    const uniqueStockNames = Array.from(new Set(transData.map(t => t.stock_name).filter(Boolean)));
    if (uniqueStockNames.length === 0) return {};

    const { data: masterData, error: masterError } = await fetchAllRows(supabase, "stock_master", {
      select: "symbol, stock_name",
      filters: [(q) => q.in("stock_name", uniqueStockNames)]
    });

    if (masterError) {
      console.error("❌ Error fetching master symbols for Yahoo:", masterError.message);
      return {};
    }

    const symbolMap = {};
    masterData.forEach(m => {
      symbolMap[m.symbol] = m.stock_name;
    });
    return symbolMap;
  } catch (error) {
    console.error("❌ getSymbolsFromTransactions Yahoo failed:", error.message);
    return {};
  }
}

async function fetchSingleSymbol(masterSymbol, stockName, from, to) {
  if (!masterSymbol) return [];
  const parts = masterSymbol.split(":");
  const prefix = parts.length > 1 ? parts[0] : null;
  const cleanSymbol = parts.length > 1 ? parts[1] : parts[0];
  
  let yahooSymbol = null;
  let finalStockName = stockName;
  if (prefix === "NSE") {
    yahooSymbol = cleanSymbol + ".NS";
    finalStockName = cleanSymbol;
  } else if (prefix === "BOM") {
    yahooSymbol = cleanSymbol + ".BO";
    finalStockName = stockName;
  } else {
    if (/^\d+$/.test(cleanSymbol)) {
      yahooSymbol = cleanSymbol + ".BO";
    } else {
      yahooSymbol = cleanSymbol + ".NS";
    }
  }

  try {
    const result = await yf.chart(yahooSymbol, {
      period1: from,
      period2: to,
      events: "div|split"
    });

    if (!result.events) return [];

    const records = [];
    if (result.events.dividends) {
      result.events.dividends.forEach(item => {
        records.push({
          symbol: masterSymbol,
          stock_name: finalStockName,
          company_name: stockName,
          action_type: "DIVIDEND",
          purpose: "Dividend",
          ex_date: parseDate(item.date.toISOString()),
          record_date: null,
          dividend_amount: item.amount,
          ratio: null,
          source: "YAHOO"
        });
      });
    }

    if (result.events.splits) {
      result.events.splits.forEach(item => {
        records.push({
          symbol: masterSymbol,
          stock_name: finalStockName,
          company_name: stockName,
          action_type: "SPLIT",
          purpose: "Stock Split",
          ex_date: parseDate(item.date.toISOString()),
          record_date: null,
          dividend_amount: null,
          ratio: item.splitRatio,
          source: "YAHOO"
        });
      });
    }
    return records;
  } catch (err) {
    if (err.name === 'HTTPError' && err.response && err.response.status === 429) {
      console.warn(`⚠️ Yahoo rate limited for ${yahooSymbol}`);
    }
    return [];
  }
}

async function saveToSupabase(records) {
  if (!records.length) return 0;

  const { error } = await supabase
    .from("corporate_actions")
    .upsert(records, { onConflict: "symbol,action_type,ex_date,source" });

  if (error) {
    console.error("❌ Yahoo Insert error:", error.message);
    return 0;
  }
  return records.length;
}

export async function runYahooActions(days = 30) {
  console.log(`🚀 Starting Yahoo Finance fallback scraper (period: ${days} days)...`);
  try {
    const startTime = Date.now();
    const { from, to } = getDateRange(days);
    
    const [symbolMap, { data: existingBonus }] = await Promise.all([
      getSymbolsFromTransactions(),
      fetchAllRows(supabase, "corporate_actions", {
        select: "symbol, ex_date",
        filters: [
          (q) => q.eq("action_type", "BONUS"),
          (q) => q.gte("ex_date", from)
        ]
      })
    ]);

    const masterSymbols = Object.keys(symbolMap);
    if (!masterSymbols.length) {
      console.log("ℹ️ No symbols to process for Yahoo");
      return;
    }

    const bonusMap = new Set((existingBonus || []).map(b => `${b.symbol}_${b.ex_date}`));
    const CONCURRENCY = 10; // Safer concurrency for main backend
    const BATCH_SAVE_SIZE = 100;
    let totalSaved = 0;
    let pendingRecords = [];
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < masterSymbols.length) {
        const sym = masterSymbols[currentIndex++];
        if (!sym) continue;
        
        const stockName = symbolMap[sym];
        const records = await fetchSingleSymbol(sym, stockName, from, to);
        if (records.length) {
          const filtered = records.filter(rec => {
            if (rec.action_type === "SPLIT") {
              const key = `${rec.symbol}_${rec.ex_date}`;
              return !bonusMap.has(key);
            }
            return true;
          });

          if (filtered.length) {
            pendingRecords.push(...filtered);
          }
        }

        if (pendingRecords.length >= BATCH_SAVE_SIZE) {
          const toSave = [...pendingRecords];
          pendingRecords = [];
          totalSaved += await saveToSupabase(toSave);
        }
        
        // Add a tiny delay to avoid overwhelming the network
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, masterSymbols.length) }, () => worker());
    await Promise.all(workers);

    if (pendingRecords.length > 0) {
      totalSaved += await saveToSupabase(pendingRecords);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Yahoo finished: ${masterSymbols.length} symbols processed, ${totalSaved} records updated in ${duration}s`);
  } catch (error) {
    console.error("❌ Yahoo Service failed:", error.message);
  }
}
