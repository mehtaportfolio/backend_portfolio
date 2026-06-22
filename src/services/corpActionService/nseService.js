import { supabase } from '../../db/supabaseClient.js';

const BASE_URL = "https://www.nseindia.com";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive"
};

function getDateRange(days = 30) {
  const today = new Date();
  const nextDate = new Date();
  nextDate.setDate(today.getDate() + days);

  const format = (d) => {
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  };

  return {
    from: format(today),
    to: format(nextDate)
  };
}

async function getCookies() {
  try {
    const res = await fetch(BASE_URL, { 
      headers, 
      signal: AbortSignal.timeout(10000) 
    });
    const cookies = res.headers.getSetCookie();
    if (!cookies || cookies.length === 0) return "";
    return cookies.map(c => c.split(";")[0]).join("; ");
  } catch (error) {
    console.error("❌ Error fetching NSE cookies:", error.message);
    return "";
  }
}

function parseAction(purpose) {
  if (!purpose) return "OTHER";
  const p = purpose.toLowerCase();
  if (p.includes("dividend")) return "DIVIDEND";
  if (p.includes("bonus")) return "BONUS";
  if (p.includes("split")) return "SPLIT";
  if (p.includes("rights")) return "RIGHTS";
  return "OTHER";
}

function parseDate(dateStr) {
  if (!dateStr || dateStr === "-") return null;
  const months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };
  const parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  return `${parts[2]}-${months[parts[1]]}-${parts[0]}`;
}

function extractDividendAmount(purpose) {
  if (!purpose) return null;
  const match = purpose.match(/rs\s*([0-9]*\.?[0-9]+)/i);
  if (match) return parseFloat(match[1]);
  const matchRe = purpose.match(/re\s*([0-9]*\.?[0-9]+)/i);
  if (matchRe) return parseFloat(matchRe[1]);
  return null;
}

function extractRatio(purpose) {
  if (!purpose) return null;
  const match = purpose.match(/(\d+:\d+)/);
  if (match) return match[1];
  const faceValueMatch = purpose.match(/From\s+R[se]\.?\s*(\d+).*?To\s+R[se]\.?\s*(\d+)/i);
  if (faceValueMatch) {
    const from = parseInt(faceValueMatch[1]);
    const to = parseInt(faceValueMatch[2]);
    if (to > 0) return `${from / to}:1`;
  }
  return null;
}

async function getSymbolsFromTransactions() {
  try {
    const { fetchAllRows } = await import('../../db/queries.js');
    const { data: transData, error: transError } = await fetchAllRows(supabase, "stock_transactions", {
      select: "stock_name",
      filters: [(q) => q.is("sell_date", null)]
    });

    if (transError) {
      console.error("❌ Error fetching transactions for NSE:", transError.message);
      return new Set();
    }

    const uniqueStockNames = Array.from(new Set(transData.map(t => t.stock_name).filter(Boolean)));
    if (uniqueStockNames.length === 0) return new Set();

    const { data: masterData, error: masterError } = await fetchAllRows(supabase, "stock_master", {
      select: "symbol",
      filters: [(q) => q.in("stock_name", uniqueStockNames)]
    });

    if (masterError) {
      console.error("❌ Error fetching master symbols for NSE:", masterError.message);
      return new Set();
    }

    const symbols = new Set();
    masterData.forEach(m => {
      if (!m.symbol) return;
      const [prefix, sym] = m.symbol.split(":");
      if (prefix === "NSE") {
        symbols.add(sym || prefix);
      } else if (!m.symbol.includes(":")) {
        symbols.add(m.symbol);
      }
    });

    return symbols;
  } catch (error) {
    console.error("❌ getSymbolsFromTransactions NSE failed:", error.message);
    return new Set();
  }
}

async function fetchNSEActions(days = 30) {
  try {
    const cookies = await getCookies();
    const { from, to } = getDateRange(days);
    const API_URL = `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${from}&to_date=${to}`;
    
    const response = await fetch(API_URL, {
      headers: {
        ...headers,
        Referer: BASE_URL,
        Cookie: cookies
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`NSE API returned status ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.error("❌ NSE fetch error:", err.message);
    return [];
  }
}

async function saveToSupabase(records) {
  const cleanRecords = records.map(item => {
    const purpose = item.subject || "";
    const actionType = parseAction(purpose);
    if (actionType === "OTHER") return null;

    return {
      symbol: "NSE:" + item.symbol,
      stock_name: item.symbol,
      company_name: item.comp,
      action_type: actionType,
      purpose: purpose,
      ex_date: parseDate(item.exDate),
      record_date: parseDate(item.recDate),
      dividend_amount: actionType === "DIVIDEND" ? extractDividendAmount(purpose) : null,
      ratio: extractRatio(purpose),
      source: "NSE"
    };
  }).filter(Boolean);

  if (!cleanRecords.length) return;

  const { error } = await supabase
    .from("corporate_actions")
    .upsert(cleanRecords, {
      onConflict: "symbol,action_type,ex_date,source"
    });

  if (error) {
    console.error("❌ NSE Insert error:", error.message);
  } else {
    console.log("✅ NSE Saved records:", cleanRecords.length);
  }
}

export async function runNSEActions(days = 30) {
  console.log(`🚀 Starting NSE corporate action scraper (period: ${days} days)...`);
  try {
    const [targetSymbols, actions] = await Promise.all([
      getSymbolsFromTransactions(),
      fetchNSEActions(days)
    ]);

    if (!actions || actions.length === 0) {
      console.log("ℹ️ No data received from NSE");
      return;
    }

    const filteredActions = Array.isArray(actions) 
        ? actions.filter(a => targetSymbols.has(a.symbol))
        : [];

    if (filteredActions.length > 0) {
      await saveToSupabase(filteredActions);
    } else {
      console.log("ℹ️ No matching symbols for NSE actions");
    }
  } catch (error) {
    console.error("❌ NSE Service failed:", error.message);
  }
}
