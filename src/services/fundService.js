import axios from 'axios';

const RETURNS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const returnsCache = new Map(); // amfi -> { ts, data }
const inflight = new Map(); // amfi -> Promise
const metaCache = { ts: 0, data: null };

function getCached(amfi) {
  const v = returnsCache.get(amfi);
  if (!v) return null;
  if (Date.now() - v.ts > RETURNS_TTL_MS) return null;
  return v.data;
}

function setCached(amfi, data) {
  returnsCache.set(amfi, { ts: Date.now(), data });
  // Bound cache size to avoid memory growth
  if (returnsCache.size > 1000) {
    const first = returnsCache.keys().next().value;
    returnsCache.delete(first);
  }
}

const calculateReturn = (startNav, endNav, days) => {
  if (days > 365) {
    // Annualized Return (CAGR) for periods > 1 year
    const years = days / 365;
    return (Math.pow(endNav / startNav, 1 / years) - 1) * 100;
  }
  // Absolute Return for periods <= 1 year
  return ((endNav - startNav) / startNav) * 100;
};

const periods = {
  "1M": 30,
  "1Y": 365,
  "3Y": 365 * 3,
  "5Y": 365 * 5,
  "7Y": 365 * 7,
  "10Y": 365 * 10,
};

const getStandardReturns = (navHistory) => {
  if (!navHistory?.length) return {};
  const today = new Date(navHistory[navHistory.length - 1].date);
  const results = {};

  for (const [key, days] of Object.entries(periods)) {
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - days);
    const closest = navHistory.find((nav) => new Date(nav.date) >= startDate);
    if (closest)
      results[key] = calculateReturn(
        closest.nav,
        navHistory[navHistory.length - 1].nav,
        days
      );
  }
  return results;
};

const getRollingReturns = (navHistory, years) => {
  const rollingReturns = [];
  if (!navHistory?.length) return rollingReturns;
  const daysInPeriod = years * 365;
  
  for (let i = 0; i < navHistory.length; i += 12) {
    const startDate = new Date(navHistory[i].date);
    const endDate = new Date(startDate);
    endDate.setFullYear(startDate.getFullYear() + years);

    const endNavObj = navHistory.find((nav) => new Date(nav.date) >= endDate);
    if (endNavObj) {
      const ret = calculateReturn(navHistory[i].nav, endNavObj.nav, daysInPeriod);
      rollingReturns.push({
        start: navHistory[i].date,
        end: endNavObj.date,
        return: ret,
      });
    }
  }
  return rollingReturns;
};

const toISODate = (ddmmyyyy) => {
  if (!ddmmyyyy) return null;
  const [d, m, y] = String(ddmmyyyy).split("-");
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};

export async function fetchFundMeta() {
  if (metaCache.data && Date.now() - metaCache.ts < RETURNS_TTL_MS) {
    return metaCache.data;
  }
  const url = "https://www.amfiindia.com/spages/NAVAll.txt";
  
  let response;
  let retries = 2;
  let lastError;

  while (retries > 0) {
    try {
      response = await axios.get(url, { 
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      break;
    } catch (err) {
      lastError = err;
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  if (!response) {
    const error = new Error(`Failed to fetch fund metadata: ${lastError.message}`);
    error.statusCode = lastError.response?.status || 500;
    throw error;
  }

  const lines = response.data.split("\n");

  const funds = [];
  let currentAMC = "";

  for (const line of lines) {
    const parts = line.split(";");
    if (parts.length < 6) {
      // This is an AMC header line (e.g., "SBI Mutual Fund")
      if (line.trim()) {
        currentAMC = line.trim();
      }
      continue;
    }

    if (!isNaN(parts[0]) && parts[0].trim() !== "") {
      const [schemeCode, , , schemeName, nav, date] = parts;

      // Basic category detection
      let category = "Other";
      const nameUpper = schemeName.toUpperCase();
      if (nameUpper.includes("LARGE")) category = "Large Cap";
      else if (nameUpper.includes("MID")) category = "Mid Cap";
      else if (nameUpper.includes("SMALL")) category = "Small Cap";
      else if (nameUpper.includes("ELSS")) category = "ELSS";
      else if (nameUpper.includes("DEBT")) category = "Debt";
      else if (nameUpper.includes("HYBRID")) category = "Hybrid";

      funds.push({
        amfi_code: schemeCode.trim(),
        scheme_name: schemeName.trim(),
        amc_name: currentAMC || "Unknown AMC",
        category,
        nav: parseFloat(nav) || null,
        date: date.trim(),
      });
    }
  }

  const result = {
    categories: [...new Set(funds.map((f) => f.category))],
    amcs: [...new Set(funds.map((f) => f.amc_name))],
    funds,
  };
  metaCache.ts = Date.now();
  metaCache.data = result;
  return result;
}

export function clearFundCache() {
  returnsCache.clear();
  inflight.clear();
  metaCache.ts = 0;
  metaCache.data = null;
}

export async function fetchFundReturns(amfiCode) {
  // Serve from cache if fresh
  const cached = getCached(amfiCode);
  if (cached) return cached;

  // Deduplicate concurrent requests
  if (inflight.has(amfiCode)) {
    try {
      return await inflight.get(amfiCode);
    } catch {
      inflight.delete(amfiCode);
      // fallthrough and try again
    }
  }

  const p = (async () => {
    const url = `https://api.mfapi.in/mf/${amfiCode}`;
    
    let data;
    let retries = 3;
    let lastError;

    while (retries > 0) {
      try {
        const response = await axios.get(url, { 
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        data = response.data;
        break;
      } catch (err) {
        lastError = err;
        retries--;
        if (retries > 0) {
          // Exponential backoff: 500ms, 1000ms
          await new Promise(resolve => setTimeout(resolve, (3 - retries) * 500));
        }
      }
    }

    if (!data) {
      const status = lastError?.response?.status || 500;
      let message = lastError?.message || "Failed to fetch fund data";
      
      if (status === 502) {
        message = "Upstream service (mfapi.in) is currently unavailable (502 Bad Gateway). Please try again later.";
      } else if (status === 504) {
        message = "Upstream service (mfapi.in) timed out (504 Gateway Timeout).";
      }

      const error = new Error(message);
      error.statusCode = status;
      throw error;
    }

    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      const error = new Error("No NAV data found for the given fund code");
      error.statusCode = 404;
      throw error;
    }

    // Build up to 20 years of monthly points in a single pass (newest-first), then reverse
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 20);
    const seenMonths = new Set();
    const navDesc = [];

    // mfapi usually returns newest-first; single pass and early-break
    for (const row of data.data) {
      const iso = toISODate(row?.date);
      const nav = parseFloat(String(row?.nav ?? "").replace(/,/g, ""));
      if (!iso || !Number.isFinite(nav)) continue;
      const d = new Date(iso);
      if (d < cutoff && navDesc.length > 0) break; // stop once we covered 20y
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!seenMonths.has(key)) {
        navDesc.push({ date: iso, nav });
        seenMonths.add(key);
      }
    }

    const navHistory = navDesc.reverse(); // oldest-first
    if (navHistory.length === 0) {
      const error = new Error("No NAV data found for the requested period");
      error.statusCode = 404;
      throw error;
    }

    const result = {
      fund: amfiCode,
      standardReturns: getStandardReturns(navHistory),
      rolling: {
        "1Y": getRollingReturns(navHistory, 1),
        "3Y": getRollingReturns(navHistory, 3),
        "5Y": getRollingReturns(navHistory, 5),
        "7Y": getRollingReturns(navHistory, 7),
        "10Y": getRollingReturns(navHistory, 10),
      },
    };
    setCached(amfiCode, result);
    return result;
  })();

  inflight.set(amfiCode, p);
  try {
    return await p;
  } finally {
    inflight.delete(amfiCode);
  }
}
