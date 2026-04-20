import { supabase } from '../../db/supabaseClient.js';
import axios from 'axios';

const API_URL = "https://api.bseindia.com/BseIndiaAPI/api/CorpAction/w";

const getHeaders = () => ({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bseindia.com/corporates/corporate_act.aspx",
  Origin: "https://www.bseindia.com",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive"
});

async function getBseCookie() {
  try {
    const res = await axios.get("https://www.bseindia.com/", { headers: getHeaders(), timeout: 10000 });
    const cookie = res.headers["set-cookie"];
    if (!cookie) return "";
    return cookie.map(c => c.split(";")[0]).join("; ");
  } catch (error) {
    console.error("❌ Error fetching BSE cookies:", error.message);
    return "";
  }
}

function getDateRange() {
  const today = new Date();
  const lastMonth = new Date();
  lastMonth.setDate(today.getDate() - 30);

  const format = d =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  return { from: format(lastMonth), to: format(today) };
}

function parseDate(dateStr) {
  if (!dateStr || dateStr === "-") return null;
  if (dateStr.includes("/")) {
    const [day, month, year] = dateStr.split("/");
    return `${year}-${month}-${day}`;
  }
  const d = new Date(dateStr);
  if (!isNaN(d)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
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

function extractDividendAmount(purpose) {
  if (!purpose) return null;
  const match = purpose.match(/(?:rs|re)[\.\s-]*([0-9]+(?:\.[0-9]+)?)/i);
  return match ? parseFloat(match[1]) : null;
}

function extractRatio(purpose) {
  if (!purpose) return null;
  const match = purpose.match(/(\d+:\d+)/);
  return match ? match[1] : null;
}

function extractSplitRatio(purpose) {
  if (!purpose) return null;
  const match = purpose.match(/From\s*Rs\.?(\d+(?:\.\d+)?)\/?-?\s*to\s*Rs\.?(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const from = parseFloat(match[1]);
  const to = parseFloat(match[2]);
  if (!from || !to) return null;
  return `${from}:${to}`;
}

function extractRecordDate(bcPeriod, exDate) {
  if (!bcPeriod || bcPeriod === "-") return exDate;
  const parts = bcPeriod.split("-");
  const dateStr = parts[parts.length - 1].trim();
  return parseDate(dateStr) || exDate;
}

async function getPortfolioCodes() {
  try {
    let allStockNames = [];
    let from = 0;
    const step = 1000;

    while (true) {
      const { data, error } = await supabase
        .from("stock_transactions")
        .select("stock_name")
        .is("sell_date", null)
        .range(from, from + step - 1);

      if (error) {
        console.error("❌ BSE Transaction error:", error.message);
        break;
      }
      if (!data || data.length === 0) break;

      allStockNames.push(...data.map(r => r.stock_name));
      if (data.length < step) break;
      from += step;
    }

    const uniqueStockNames = [...new Set(allStockNames.filter(Boolean))];
    if (uniqueStockNames.length === 0) return [];

    const { data: master, error: masterError } = await supabase
      .from("stock_master")
      .select("stock_name, symbol")
      .in("stock_name", uniqueStockNames);

    if (masterError) {
      console.error("❌ BSE Master error:", masterError.message);
      return [];
    }

    const codes = master
      .filter(r => r.symbol && r.symbol.includes("BOM:"))
      .map(r => r.symbol.replace("BOM:", ""));

    return codes;
  } catch (error) {
    console.error("❌ getPortfolioCodes for BSE failed:", error.message);
    return [];
  }
}

async function fetchActionsForCode(code, range, cookie) {
  const url = `${API_URL}?scripcode=${code}&fromDt=${range.from}&toDt=${range.to}&period=Selected&expandable=0`;

  try {
    const res = await axios.get(url, { 
      headers: { ...getHeaders(), Cookie: cookie },
      timeout: 15000 
    });
    
    if (typeof res.data === 'string' && res.data.includes("Access Denied")) {
      return [];
    }
    const data = res.data;
    if (!Array.isArray(data)) return [];
    return data;
  } catch (err) {
    return [];
  }
}

async function saveToSupabase(records, portfolioSymbols) {
  const clean = records
    .map(item => {
      const actionType = parseAction(item.Purpose);
      let dividendAmount = null;
      let ratio = null;

      if (actionType === "DIVIDEND") {
        dividendAmount = extractDividendAmount(item.Purpose);
        ratio = extractRatio(item.Purpose) || null;
      } else if (actionType === "SPLIT") {
        ratio = extractRatio(item.Purpose) || extractSplitRatio(item.Purpose);
        dividendAmount = null;
      } else if (["BONUS", "RIGHTS"].includes(actionType)) {
        ratio = extractRatio(item.Purpose);
        dividendAmount = null;
      }

      return {
        symbol: "BOM:" + String(item.Code),
        stock_name: item.Security,
        company_name: item.Security,
        action_type: actionType,
        purpose: item.Purpose,
        ex_date: parseDate(item.ExDate),
        record_date: extractRecordDate(item.BCPeriod, parseDate(item.ExDate)),
        dividend_amount: dividendAmount,
        ratio: ratio,
        source: "BSE"
      };
    })
    .filter(r => r.action_type !== "OTHER" && portfolioSymbols.has(r.symbol));

  if (clean.length === 0) return;

  // Deduplicate within the fetched data
  const uniqueInFetch = new Map();
  clean.forEach(r => {
    const key = `${r.symbol}-${r.action_type}-${r.ex_date}-${r.source}`;
    if (!uniqueInFetch.has(key)) uniqueInFetch.set(key, r);
  });
  const finalRecords = Array.from(uniqueInFetch.values());

  const { error } = await supabase
    .from("corporate_actions")
    .upsert(finalRecords, { onConflict: "symbol,action_type,ex_date,source" });

  if (error) {
    console.error("❌ BSE Insert error:", error.message);
  } else {
    console.log(`✅ BSE Saved records: ${finalRecords.length}`);
  }
}

export async function runBSEActions() {
  console.log("🚀 Starting BSE corporate action scraper...");
  try {
    const cookie = await getBseCookie();
    const range = getDateRange();
    const codes = await getPortfolioCodes();
    
    if (codes.length === 0) {
      console.log("ℹ️ No BSE portfolio stocks found");
      return;
    }

    const portfolioSymbols = new Set(codes.map(s => "BOM:" + s));
    const batchSize = 5;
    let allActions = [];

    for (let i = 0; i < codes.length; i += batchSize) {
      const batch = codes.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(code => fetchActionsForCode(code, range, cookie))
      );

      results
        .filter(r => r.status === "fulfilled")
        .forEach(r => allActions.push(...r.value));

      if (i + batchSize < codes.length) {
        await new Promise(res => setTimeout(res, 500));
      }
    }

    if (allActions.length > 0) {
      await saveToSupabase(allActions, portfolioSymbols);
    } else {
      console.log("ℹ️ No data received from BSE");
    }
  } catch (error) {
    console.error("❌ BSE Service failed:", error.message);
  }
}
