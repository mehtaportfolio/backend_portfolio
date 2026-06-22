/**
 * Stock Service
 * Handles open/closed stock holdings, ETF data, and portfolio aggregations
 */

import { fetchAllRows, insertRows, updateRows, deleteRows } from '../db/queries.js';

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365;

/**
 * Calculate XIRR using Newton-Raphson bisection method
 */
function calculateXIRR(flows) {
  if (!flows || flows.length < 2) return null;

  const cashflows = flows
    .map((cf) => ({
      amount: toNumber(cf.amount),
      date: new Date(cf.date),
    }))
    .sort((a, b) => a.date - b.date);

  const t0 = cashflows[0].date;
  const npv = (rate) =>
    cashflows.reduce(
      (acc, cf) =>
        acc + cf.amount / Math.pow(1 + rate, (cf.date - t0) / MS_PER_YEAR),
      0
    );

  let low = -0.9999;
  let high = 100;

  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const val = npv(mid);
    if (Math.abs(val) < 1e-6) return mid * 100;
    if (val > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2 * 100;
}

/**
 * Normalize stock name: uppercase + trim + remove extra spaces
 */
function normalizeStockName(name) {
  return String(name || '').trim().toUpperCase();
}

/**
 * Get Zerodha Token Status
 */
export async function getZerodhaTokenStatus(supabase) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await fetchAllRows(supabase, 'zerodha_tokens', {
      select: 'account_id, updated_at'
    });

    if (error) throw error;

    const statuses = { PM: false, PDM: false, PSM: false };
    (data || []).forEach((token) => {
      const tokenDate = new Date(token.updated_at).toISOString().split('T')[0];
      if (tokenDate === today) {
        statuses[token.account_id] = true;
      }
    });

    return statuses;
  } catch (error) {
    console.error('[Stock] Error fetching Zerodha token statuses:', error);
    throw error;
  }
}

/**
 * Resolve accountNames from user_master
 */
async function getAccountNames(supabase) {
  // Single-user mode: return all account names from user_master
  const { data: userMaster } = await fetchAllRows(supabase, 'user_master', {
    select: 'account_name'
  });

  if (userMaster && userMaster.length > 0) {
    const accountNames = userMaster.map(u => u.account_name).filter(Boolean);
    return [...new Set(accountNames)];
  }

  return [];
}

/**
 * Get open stock holdings grouped by stock name
 */
export async function getOpenStockData(supabase, priceSource = 'stock_master') {
  try {
    // Fetch open transactions for Free/Regular accounts
    const { data: transactions, error: txnError } = await fetchAllRows(
      supabase,
      'stock_transactions',
      {
        select: 'id, stock_name, quantity, buy_price, buy_date, account_name, account_type, equity_type',
        filters: [
          (q) => q.is('sell_date', null)
        ],
      }
    );

    const filteredTransactions = (transactions || []).filter(t => 
      t.equity_type?.toLowerCase() === 'stocks' && ['free', 'regular'].includes(t.account_type?.toLowerCase())
    );

    if (txnError) throw txnError;

    // Determine which table to fetch from
    const priceTable = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';

    // Fetch prices from selected source (stock_master or stock_mapping)
    // Note: stock_mapping may not have category/sector columns, so we only select what's guaranteed
    const priceSelect = priceTable === 'stock_mapping' 
      ? 'stock_name, cmp, lcp, symbol_ao'
      : 'stock_name, cmp, lcp, category, sector, basic_industry';
    
    let { data: masters, error: masterError } = await fetchAllRows(
      supabase,
      priceTable,
      {
        select: priceSelect,
      }
    );

    if (masterError) {
      console.error(`[Stock] ❌ Error fetching from ${priceTable}:`, masterError);
      
      // Fallback to stock_master if the selected table fails
      const { data: fallbackMasters, error: fallbackError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, cmp, lcp, category, sector, basic_industry',
        }
      );
      
      if (fallbackError) throw fallbackError;
      masters = fallbackMasters;
    }
    
    // If we used stock_mapping, also fetch category/sector from stock_master for enrichment
    let categoryData = [];
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterEnrich, error: enrichError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, category, sector, basic_industry',
        }
      );
      if (!enrichError && masterEnrich) {
        categoryData = masterEnrich;
      }
    } else if (masters) {
      categoryData = masters; // Already have category/sector from stock_master
    }
    
    // 🔹 When using stock_mapping (Angel One), fetch stock_master data as fallback
    let stockMasterFallbackMap = {};
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterForFallback } = await fetchAllRows(
        supabase,
        'stock_master',
        { select: 'stock_name, cmp, lcp' }
      );
      (masterForFallback || []).forEach((m) => {
        const normalizedKey = normalizeStockName(m.stock_name);
        stockMasterFallbackMap[normalizedKey] = {
          cmp: toNumber(m.cmp),
          lcp: toNumber(m.lcp),
        };
      });
    }

    const masterMap = {};
    const categoryMap = {};
    const sectorMap = {};
    const basicIndustryMap = {};
    const symbolAoMap = {};

    // Create maps with normalized keys to handle name mismatches
    (masters || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      let cmp = toNumber(m.cmp);
      let lcp = toNumber(m.lcp);
      let symbol_ao = m.symbol_ao || null;
      
      // 🔹 Fallback: If stock_mapping CMP or LCP is missing/invalid, use stock_master values
      if (priceTable === 'stock_mapping') {
        const fallback = stockMasterFallbackMap[normalizedKey];
        if ((!cmp || cmp === 0) && fallback?.cmp) {
          cmp = fallback.cmp;
        }
        if ((!lcp || lcp === 0) && fallback?.lcp) {
          lcp = fallback.lcp;
        }
      }
      
      masterMap[normalizedKey] = {
        cmp: cmp,
        lcp: lcp,
        symbol_ao: symbol_ao,
      };
    });
    
    // Populate category and sector maps
    (categoryData || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      if (m.category) categoryMap[normalizedKey] = m.category;
      if (m.sector) sectorMap[normalizedKey] = m.sector;
      if (m.basic_industry) basicIndustryMap[normalizedKey] = m.basic_industry;
      if (m.symbol_ao) symbolAoMap[normalizedKey] = m.symbol_ao;
    });

    // Group by stock name, with normalized lookup
    const grouped = {};
    (filteredTransactions || []).forEach((txn) => {
      const stockName = String(txn.stock_name).trim();
      const normalizedKey = normalizeStockName(txn.stock_name);
      if (!grouped[stockName]) {
        grouped[stockName] = {
          stock_name: stockName,
          transactions: [],
          cmp: masterMap[normalizedKey]?.cmp || 0,
          lcp: masterMap[normalizedKey]?.lcp || 0,
          symbol_ao: masterMap[normalizedKey]?.symbol_ao || symbolAoMap[normalizedKey] || null,
          category: categoryMap[normalizedKey] || null,
          sector: sectorMap[normalizedKey] || null,
          basic_industry: basicIndustryMap[normalizedKey] || null,
        };
      }
      grouped[stockName].transactions.push(txn);
    });

    // Calculate holdings
    const holdings = [];
    Object.values(grouped).forEach((group) => {
      let invested = 0;
      let openQty = 0;
      const cashflows = [];

      group.transactions.forEach((txn) => {
        const qty = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        invested += qty * buyPrice;
        openQty += qty;

        if (txn.buy_date) {
          cashflows.push({
            amount: -(qty * buyPrice),
            date: new Date(txn.buy_date),
          });
        }
      });

      const cmp = group.cmp;
      const lcp = group.lcp;
      const marketValue = openQty * cmp;
      const urp = marketValue - invested;
      const urpPct = invested > 1e-8 ? (urp / invested) * 100 : 0;

      if (openQty > 0 && cmp > 0) {
        cashflows.push({ amount: marketValue, date: new Date() });
      }

      const changePct =
        !isNaN(cmp) && !isNaN(lcp) && lcp !== 0 ? ((cmp - lcp) / lcp) * 100 : null;
      const xirr = calculateXIRR(cashflows);

      holdings.push({
        stock_name: group.stock_name,
        livePrice: cmp,
        lcp: lcp,
        symbol_ao: group.symbol_ao,
        changePct: changePct,
        invested: invested,
        marketValue: marketValue,
        urp: urp,
        urpPct: urpPct,
        xirr: xirr,
        quantity: openQty,
        equity_type: group.transactions[0]?.equity_type,
        account_type: group.transactions[0]?.account_type,
        transactions: group.transactions,
        category: group.category,
        sector: group.sector,
        basic_industry: group.basic_industry,
      });
    });

    // Sort by name
    holdings.sort((a, b) => a.stock_name.localeCompare(b.stock_name));

    // Calculate summary
    const summary = {
      invested: holdings.reduce((sum, h) => sum + h.invested, 0),
      currentValue: holdings.reduce((sum, h) => sum + h.marketValue, 0),
      dayChange:
        holdings.reduce(
          (sum, h) =>
            sum +
            (h.transactions || []).reduce(
              (txnSum, txn) =>
                txnSum + toNumber(txn.quantity) * (h.lcp > 0 ? (h.livePrice - h.lcp) : 0),
              0
            ),
          0
        ),
    };

    // Calculate overall XIRR
    const allCashflows = [];
    holdings.forEach((h) => {
      h.transactions.forEach((txn) => {
        const qty = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        if (txn.buy_date) {
          allCashflows.push({
            amount: -(qty * buyPrice),
            date: new Date(txn.buy_date),
          });
        }
      });
    });

    if (summary.currentValue > 0) {
      allCashflows.push({ amount: summary.currentValue, date: new Date() });
    }

    summary.absReturn = summary.currentValue - summary.invested;
    summary.returnPct =
      summary.invested > 1e-8 ? (summary.absReturn / summary.invested) * 100 : 0;
    summary.xirr = calculateXIRR(allCashflows);

    return {
      holdings,
      summary,
      masterMap,
      categoryMap,
      sectorMap,
    };
  } catch (error) {
    console.error('[Stock] Error fetching open stock data:', error);
    throw error;
  }
}

/**
 * Get closed stock holdings
 */
export async function getClosedStockData(supabase, priceSource = 'stock_master') {
  try {
    // Fetch closed transactions
    const { data: transactions, error: txnError } = await fetchAllRows(
      supabase,
      'stock_transactions',
      {
        select:
          'id, stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type, equity_type',
        filters: [
          (q) => q.not('sell_date', 'is', null)
        ],
      }
    );

    if (txnError) throw txnError;

    // Determine which table to fetch from
    const priceTable = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';

    const priceSelect = priceTable === 'stock_mapping' 
      ? 'stock_name, cmp, lcp'
      : 'stock_name, cmp, lcp, category, sector, basic_industry';

    // Fetch prices from selected source
    let { data: masters, error: masterError } = await fetchAllRows(
      supabase,
      priceTable,
      {
        select: priceSelect,
      }
    );

    if (masterError) {
      console.error(`[Stock] Error fetching from ${priceTable}:`, masterError);
      
      const { data: fallbackMasters, error: fallbackError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, cmp, lcp, category, sector, basic_industry',
        }
      );
      
      if (fallbackError) throw fallbackError;
      masters = fallbackMasters;
    }

    // 🔹 When using stock_mapping (Angel One), also fetch category/sector/basic_industry from stock_master
    let categoryData = [];
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterEnrich, error: enrichError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, category, sector, basic_industry',
        }
      );
      if (!enrichError && masterEnrich) {
        categoryData = masterEnrich;
      }
    } else if (masters) {
      categoryData = masters;
    }

    // 🔹 When using stock_mapping (Angel One), fetch stock_master data as fallback for prices
    let stockMasterFallbackMapClosed = {};
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterForFallback } = await fetchAllRows(
        supabase,
        'stock_master',
        { select: 'stock_name, cmp, lcp' }
      );
      (masterForFallback || []).forEach((m) => {
        const normalizedKey = normalizeStockName(m.stock_name);
        stockMasterFallbackMapClosed[normalizedKey] = {
          cmp: toNumber(m.cmp),
          lcp: toNumber(m.lcp),
        };
      });
    }

    const masterMap = {};
    const categoryMap = {};
    const sectorMap = {};
    const basicIndustryMap = {};

    (masters || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      let cmp = toNumber(m.cmp);
      let lcp = toNumber(m.lcp);
      
      // 🔹 Fallback: If stock_mapping CMP or LCP is missing/invalid, use stock_master values
      if (priceTable === 'stock_mapping') {
        const fallback = stockMasterFallbackMapClosed[normalizedKey];
        if ((!cmp || cmp === 0) && fallback?.cmp) {
          cmp = fallback.cmp;
        }
        if ((!lcp || lcp === 0) && fallback?.lcp) {
          lcp = fallback.lcp;
        }
      }
      
      masterMap[normalizedKey] = {
        cmp: cmp,
        lcp: lcp,
      };
    });

    // Populate category, sector, basic_industry maps
    (categoryData || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      if (m.category) categoryMap[normalizedKey] = m.category;
      if (m.sector) sectorMap[normalizedKey] = m.sector;
      if (m.basic_industry) basicIndustryMap[normalizedKey] = m.basic_industry;
    });

    // Group by stock name
    const grouped = {};
    (transactions || []).forEach((txn) => {
      const stockName = String(txn.stock_name).trim();
      const normalizedKey = normalizeStockName(txn.stock_name);
      if (!grouped[stockName]) {
        grouped[stockName] = {
          stock_name: stockName,
          transactions: [],
          cmp: masterMap[normalizedKey]?.cmp || 0,
          lcp: masterMap[normalizedKey]?.lcp || 0,
          category: categoryMap[normalizedKey] || null,
          sector: sectorMap[normalizedKey] || null,
          basic_industry: basicIndustryMap[normalizedKey] || null,
        };
      }
      grouped[stockName].transactions.push(txn);
    });

    // Calculate holdings
    const holdings = [];
    Object.values(grouped).forEach((group) => {
      let invested = 0;
      let closedValue = 0;
      let xirrValues = [];

      group.transactions.forEach((txn) => {
        const qty = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        const sellPrice = toNumber(txn.sell_price || 0);
        const inv = qty * buyPrice;
        const val = qty * sellPrice;

        invested += inv;
        closedValue += val;

        // Calculate per-transaction XIRR
        if (txn.buy_date && txn.sell_date) {
          const days =
            (new Date(txn.sell_date) - new Date(txn.buy_date)) /
            (1000 * 60 * 60 * 24);
          if (days > 0 && inv > 0 && val > 0) {
            const txnXirr = Math.pow(val / inv, 365 / days) - 1;
            xirrValues.push(txnXirr * 100);
          }
        }
      });

      const urp = closedValue - invested;
      const urpPct = invested > 1e-8 ? (urp / invested) * 100 : 0;
      const avgXirr =
        xirrValues.length > 0
          ? (xirrValues.reduce((a, b) => a + b, 0) / xirrValues.length)
          : null;

      holdings.push({
        stock_name: group.stock_name,
        invested: invested,
        marketValue: closedValue,
        urp: urp,
        urpPct: urpPct,
        xirr: avgXirr,
        transactions: group.transactions,
        category: group.category,
        sector: group.sector,
        basic_industry: group.basic_industry,
      });
    });

    // Sort by name
    holdings.sort((a, b) => a.stock_name.localeCompare(b.stock_name));

    return {
      holdings,
      masterMap,
    };
  } catch (error) {
    console.error('[Stock] Error fetching closed stock data:', error);
    throw error;
  }
}

/**
 * Get ETF holdings
 */
export async function getETFData(supabase, priceSource = 'stock_master') {
  try {
    const { data: transactions, error: txnError } = await fetchAllRows(
      supabase,
      'stock_transactions',
      {
        select:
          'id, stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type, equity_type'
      }
    );

    const etfTransactions = (transactions || []).filter(t => t.equity_type?.toLowerCase() === 'etf');

    if (txnError) throw txnError;

    // Determine which table to fetch from
    const priceTable = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';

    const priceSelect = priceTable === 'stock_mapping' 
      ? 'stock_name, cmp, lcp, symbol_ao'
      : 'stock_name, cmp, lcp, category, sector, basic_industry';

    // Fetch prices from selected source
    let { data: masters, error: masterError } = await fetchAllRows(
      supabase,
      priceTable,
      {
        select: priceSelect,
      }
    );

    if (masterError) {
      console.error(`[Stock] Error fetching from ${priceTable}:`, masterError);
      
      const { data: fallbackMasters, error: fallbackError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, cmp, lcp, category, sector, basic_industry',
        }
      );
      
      if (fallbackError) throw fallbackError;
      masters = fallbackMasters;
    }

    // 🔹 When using stock_mapping (Angel One), fetch stock_master data as fallback
    let categoryData = [];
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterEnrich, error: enrichError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, category, sector, basic_industry',
        }
      );
      if (!enrichError && masterEnrich) {
        categoryData = masterEnrich;
      }
    } else if (masters) {
      categoryData = masters;
    }

    // 🔹 When using stock_mapping (Angel One), fetch stock_master data as fallback for prices
    let stockMasterFallbackMapETF = {};
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterForFallback } = await fetchAllRows(
        supabase,
        'stock_master',
        { select: 'stock_name, cmp, lcp' }
      );
      (masterForFallback || []).forEach((m) => {
        const normalizedKey = normalizeStockName(m.stock_name);
        stockMasterFallbackMapETF[normalizedKey] = {
          cmp: toNumber(m.cmp),
          lcp: toNumber(m.lcp),
        };
      });
    }

    const masterMap = {};
    const categoryMap = {};
    const sectorMap = {};
    const basicIndustryMap = {};
    const symbolAoMap = {};

    (masters || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      let cmp = toNumber(m.cmp);
      let lcp = toNumber(m.lcp);
      let symbol_ao = m.symbol_ao || null;
      
      // 🔹 Fallback: If stock_mapping CMP or LCP is missing/invalid, use stock_master values
      if (priceTable === 'stock_mapping') {
        const fallback = stockMasterFallbackMapETF[normalizedKey];
        if ((!cmp || cmp === 0) && fallback?.cmp) {
          cmp = fallback.cmp;
        }
        if ((!lcp || lcp === 0) && fallback?.lcp) {
          lcp = fallback.lcp;
        }
      }
      
      masterMap[normalizedKey] = {
        cmp: cmp,
        lcp: lcp,
        symbol_ao: symbol_ao,
      };
    });

    // Populate category, sector, basic_industry maps
    (categoryData || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      if (m.category) categoryMap[normalizedKey] = m.category;
      if (m.sector) sectorMap[normalizedKey] = m.sector;
      if (m.basic_industry) basicIndustryMap[normalizedKey] = m.basic_industry;
    });

    // Group by stock name
    const grouped = {};
    (etfTransactions || []).forEach((txn) => {
      const stockName = String(txn.stock_name).trim();
      const normalizedKey = normalizeStockName(txn.stock_name);
      if (!grouped[stockName]) {
        grouped[stockName] = {
          stock_name: stockName,
          transactions: [],
          cmp: masterMap[normalizedKey]?.cmp || 0,
          lcp: masterMap[normalizedKey]?.lcp || 0,
          symbol_ao: masterMap[normalizedKey]?.symbol_ao || null,
          category: categoryMap[normalizedKey] || null,
          sector: sectorMap[normalizedKey] || null,
          basic_industry: basicIndustryMap[normalizedKey] || null,
        };
      }
      grouped[stockName].transactions.push(txn);
    });

    const holdings = [];
    Object.values(grouped).forEach((group) => {
      const openTxns = group.transactions.filter((t) => !t.sell_date);
      const closedTxns = group.transactions.filter((t) => t.sell_date);

      // Calculate open
      let openInvested = 0;
      let openQty = 0;
      openTxns.forEach((txn) => {
        const qty = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        openInvested += qty * buyPrice;
        openQty += qty;
      });

      const cmp = group.cmp;
      const lcp = group.lcp;
      const openMarketValue = openQty * cmp;

      // Calculate closed
      let closedInvested = 0;
      let closedValue = 0;
      closedTxns.forEach((txn) => {
        const qty = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        const sellPrice = toNumber(txn.sell_price || 0);
        closedInvested += qty * buyPrice;
        closedValue += qty * sellPrice;
      });

      const urp = openMarketValue - openInvested;
      const urpPct = openInvested > 1e-8 ? (urp / openInvested) * 100 : 0;
      const avgBuyPrice = openQty > 0 ? openInvested / openQty : 0;

      const cashflows = [];
      openTxns.forEach((txn) => {
        const qty = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        if (txn.buy_date) {
          cashflows.push({
            amount: -(qty * buyPrice),
            date: new Date(txn.buy_date),
          });
        }
      });

      if (openQty > 0 && cmp > 0) {
        cashflows.push({ amount: openMarketValue, date: new Date() });
      }

      const openXirr = calculateXIRR(cashflows);

      holdings.push({
        stock_name: group.stock_name,
        livePrice: cmp,
        lcp: lcp,
        symbol_ao: group.symbol_ao,
        invested: openInvested,
        marketValue: openMarketValue,
        urp: urp,
        urpPct: urpPct,
        avgBuyPrice: avgBuyPrice,
        xirr: openXirr,
        transactions: openTxns,
        category: group.category,
        sector: group.sector,
        basic_industry: group.basic_industry,
        closedHoldings: {
          invested: closedInvested,
          value: closedValue,
          profit: closedValue - closedInvested,
        },
      });
    });

    // Calculate summary for open holdings
    const summary = {
      invested: holdings.reduce((sum, h) => sum + h.invested, 0),
      currentValue: holdings.reduce((sum, h) => sum + h.marketValue, 0),
      dayChange: holdings.reduce((sum, h) => {
        const openQty = (h.transactions || []).reduce((qty, txn) => qty + toNumber(txn.quantity), 0);
        return sum + (openQty * (h.livePrice - h.lcp));
      }, 0),
    };

    return {
      holdings,
      summary,
      masterMap,
    };
  } catch (error) {
    console.error('[Stock] Error fetching ETF data:', error);
    throw error;
  }
}

/**
 * Get portfolio summary with account-wise breakdown
 */
export async function getPortfolioData(supabase, priceSource = 'stock_master') {
  try {
    const priceTable = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';

    // Only select columns that are guaranteed to exist in the price table
    const priceSelect = priceTable === 'stock_mapping' 
      ? 'stock_name, cmp, lcp, symbol_ao'
      : 'stock_name, cmp, lcp, category, sector';

    const [
      { data: transactions, error: txnError },
      { data: masters, error: masterError },
      { data: chargesData, error: chargesError },
    ] = await Promise.all([
      fetchAllRows(supabase, 'stock_transactions', {
        select:
          'id, stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type, equity_type'
      }),
      fetchAllRows(supabase, priceTable, {
        select: priceSelect,
      }),
      fetchAllRows(supabase, 'equity_charges', {
        select: 'account_name, year, fy, other_charges, dp_charges'
      }),
    ]);

    // Fallback to stock_master if the selected table fails
    let finalMasters = masters;
    if (masterError) {
      console.error(`[Stock] Error fetching from ${priceTable}:`, masterError);
      
      const { data: fallbackMasters, error: fallbackError } = await fetchAllRows(
        supabase,
        'stock_master',
        {
          select: 'stock_name, cmp, lcp, category, sector',
        }
      );
      
      if (fallbackError) throw fallbackError;
      finalMasters = fallbackMasters;
    }

    if (txnError || chargesError) {
      throw new Error('Failed to fetch portfolio data');
    }

    // 🔹 When using stock_mapping (Angel One), fetch stock_master data as fallback
    let stockMasterFallbackMapPortfolio = {};
    if (priceTable === 'stock_mapping' && !masterError) {
      const { data: masterForFallback } = await fetchAllRows(
        supabase,
        'stock_master',
        { select: 'stock_name, cmp, lcp' }
      );
      (masterForFallback || []).forEach((m) => {
        const normalizedKey = normalizeStockName(m.stock_name);
        stockMasterFallbackMapPortfolio[normalizedKey] = {
          cmp: toNumber(m.cmp),
          lcp: toNumber(m.lcp),
        };
      });
    }

    const masterMap = {};
    (finalMasters || []).forEach((m) => {
      const normalizedKey = normalizeStockName(m.stock_name);
      let cmp = toNumber(m.cmp);
      let lcp = toNumber(m.lcp);
      let symbol_ao = m.symbol_ao || null;
      
      // 🔹 Fallback: If stock_mapping CMP or LCP is missing/invalid, use stock_master values
      if (priceTable === 'stock_mapping') {
        const fallback = stockMasterFallbackMapPortfolio[normalizedKey];
        if ((!cmp || cmp === 0) && fallback?.cmp) {
          cmp = fallback.cmp;
        }
        if ((!lcp || lcp === 0) && fallback?.lcp) {
          lcp = fallback.lcp;
        }
      }
      
      masterMap[normalizedKey] = {
        cmp: cmp,
        lcp: lcp,
        category: m.category,
        sector: m.sector,
        symbol_ao: symbol_ao,
      };
    });

    const openTxns = (transactions || []).filter((t) => !t.sell_date);
    const closedTxns = (transactions || []).filter((t) => t.sell_date);

    // Calculate open stats
    let openInvested = 0;
    let openCurrentValue = 0;
    let openDayChange = 0;
    const openCashflows = [];

    openTxns.forEach((txn) => {
      const qty = toNumber(txn.quantity);
      const buyPrice = toNumber(txn.buy_price);
      const normalizedKey = normalizeStockName(txn.stock_name);
      const cmp = masterMap[normalizedKey]?.cmp || 0;
      const lcp = masterMap[normalizedKey]?.lcp || 0;

      const investment = qty * buyPrice;
      openInvested += investment;
      openCurrentValue += qty * cmp;
      openDayChange += qty * (cmp - lcp);

      if (txn.buy_date) {
        openCashflows.push({
          amount: -investment,
          date: new Date(txn.buy_date),
        });
      }
    });

    if (openCurrentValue > 0) {
      openCashflows.push({ amount: openCurrentValue, date: new Date() });
    }

    const openStats = {
      invested: openInvested,
      currentValue: openCurrentValue,
      dayChange: openDayChange,
      absReturn: openCurrentValue - openInvested,
      returnPct:
        openInvested > 1e-8
          ? ((openCurrentValue - openInvested) / openInvested) * 100
          : 0,
      xirr: calculateXIRR(openCashflows),
    };

    const openSummary = openTxns.reduce((acc, txn) => {
      const stockName = String(txn.stock_name || '').trim();
      if (!stockName) {
        return acc;
      }

      if (!acc[stockName]) {
        const normalizedKey = normalizeStockName(txn.stock_name);
        acc[stockName] = {
          stock_name: stockName,
          quantity: 0,
          invested: 0,
          currentValue: 0,
          dayChange: 0,
          cmp: masterMap[normalizedKey]?.cmp || 0,
          lcp: masterMap[normalizedKey]?.lcp || 0,
          symbol_ao: masterMap[normalizedKey]?.symbol_ao || null,
        };
      }

      const group = acc[stockName];
      const qty = toNumber(txn.quantity);
      const buyPrice = toNumber(txn.buy_price);
      const cmp = group.cmp;
      const lcp = group.lcp;

      group.quantity += qty;
      group.invested += qty * buyPrice;
      group.currentValue += qty * cmp;
      group.dayChange += qty * (cmp - lcp);

      return acc;
    }, {});

    // Calculate closed stats with charges
    let closedInvested = 0;
    let closedValue = 0;
    const closedCashflows = [];
    let totalCharges = 0;

    // Calculate total charges for proportional allocation
    (chargesData || []).forEach((row) => {
      if (row.year !== null) {
        totalCharges +=
          toNumber(row.other_charges) + toNumber(row.dp_charges);
      }
    });

    const totalClosedInvested = closedTxns.reduce(
      (sum, txn) =>
        sum + toNumber(txn.quantity) * toNumber(txn.buy_price),
      0
    );

    closedTxns.forEach((txn) => {
      const qty = toNumber(txn.quantity);
      const buyPrice = toNumber(txn.buy_price);
      const sellPrice = toNumber(txn.sell_price || 0);

      const investment = qty * buyPrice;
      closedInvested += investment;
      closedValue += qty * sellPrice;

      // Proportional charge allocation
      const allocatedCharges =
        totalCharges *
        (totalClosedInvested > 0 ? investment / totalClosedInvested : 0);

      if (txn.buy_date) {
        closedCashflows.push({
          amount: -investment,
          date: new Date(txn.buy_date),
        });
      }

      if (txn.sell_date) {
        closedCashflows.push({
          amount: qty * sellPrice - allocatedCharges,
          date: new Date(txn.sell_date),
        });
      }
    });

    const closedProfit = closedValue - closedInvested - totalCharges;
    const closedStats = {
      invested: closedInvested,
      realizedValue: closedValue,
      realizedProfit: closedProfit,
      returnPct:
        closedInvested > 1e-8 ? (closedProfit / closedInvested) * 100 : 0,
      xirr: calculateXIRR(closedCashflows),
      totalCharges: totalCharges,
    };

    return {
      openStats,
      openSummary: Object.values(openSummary),
      openTransactions: openTxns,
      closedTransactions: closedTxns,
      closedStats,
      chargesData: chargesData || [],
      masterMap,
    };
  } catch (error) {
    console.error('[Stock] Error fetching portfolio data:', error);
    throw error;
  }
}  
/**  
 * Bulk update account type for a stock  
 */  
export async function bulkUpdateAccountType(supabase, stockName, newAccountType) {  
  try {  
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    const { error } = await updateRows(supabase, 'stock_transactions', 
      { account_type: newAccountType }, 
      (q) => q.eq('stock_name', stockName).in('account_name', accountNames)
    );  
  
    if (error) throw error;  
  
    return { success: true };  
  } catch (error) {  
    console.error('[Stock] Error in bulkUpdateAccountType:', error);  
    throw error;  
  }  
}

/**
 * Add a stock transaction
 */
export async function addStockTransaction(supabase, transaction) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    if (transaction.account_name && !accountNames.includes(transaction.account_name)) {
      throw new Error(`Unauthorized: Account "${transaction.account_name}" does not belong to this user`);
    }

    const { data, error } = await insertRows(supabase, 'stock_transactions', transaction);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addStockTransaction:', error);
    throw error;
  }
}

/**
 * Update a stock transaction
 */
export async function updateStockTransaction(supabase, id, updates) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    const { data, error } = await updateRows(supabase, 'stock_transactions', updates, 
      (q) => q.eq('id', id).in('account_name', accountNames)
    );

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Transaction not found or unauthorized');
    }
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateStockTransaction:', error);
    throw error;
  }
}

/**
 * Delete a stock transaction
 */
export async function deleteStockTransaction(supabase, id) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    const { error } = await deleteRows(supabase, 'stock_transactions', 
      (q) => q.eq('id', id).in('account_name', accountNames)
    );

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteStockTransaction:', error);
    throw error;
  }
}

/**
 * Sell a stock transaction (handles splitting if necessary)
 */
export async function sellStockTransaction(supabase, id, sellDetails) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    const { sellQty, sellDate, sellPrice } = sellDetails;

    // Get the original transaction
    const { data: originalTxns, error: fetchError } = await fetchAllRows(supabase, 'stock_transactions', {
      filters: [
        (q) => q.eq('id', id),
        (q) => q.in('account_name', accountNames)
      ],
      limit: 1
    });

    if (fetchError) throw fetchError;
    if (!originalTxns || originalTxns.length === 0) throw new Error('Transaction not found or unauthorized');
    const originalTxn = originalTxns[0];

    const originalQty = toNumber(originalTxn.quantity);

    if (sellQty === originalQty) {
      // Full sell
      const { error } = await updateRows(supabase, 'stock_transactions', 
        { sell_date: sellDate, sell_price: sellPrice },
        (q) => q.eq('id', id).in('account_name', accountNames)
      );
      if (error) throw error;
    } else {
      // Partial sell
      // 1. Update original transaction with remaining quantity
      const { error: updateError } = await updateRows(supabase, 'stock_transactions', 
        { quantity: originalQty - sellQty },
        (q) => q.eq('id', id).in('account_name', accountNames)
      );
      if (updateError) throw updateError;

      // 2. Insert new transaction with sell details
      const { error: insertError } = await insertRows(supabase, 'stock_transactions', {
        stock_name: originalTxn.stock_name,
        buy_date: originalTxn.buy_date,
        buy_price: originalTxn.buy_price,
        quantity: sellQty,
        account_name: originalTxn.account_name,
        account_type: originalTxn.account_type,
        equity_type: originalTxn.equity_type,
        sell_date: sellDate,
        sell_price: sellPrice,
      });
      if (insertError) throw insertError;
    }

    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in sellStockTransaction:', error);
    throw error;
  }
}

/**
 * Get unique account names from stock transactions and equity positions
 */
export async function getStockAccountNames(supabase, type = "") {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      return { success: true, data: [] };
    }

    const fetchPromises = [
      fetchAllRows(supabase, 'stock_transactions', {
        select: 'account_name',
        filters: [(q) => q.in('account_name', accountNames)]
      }),
      fetchAllRows(supabase, 'equity_positions', {
        select: 'account_id',
        filters: [(q) => q.in('account_id', accountNames)]
      })
    ];

    if (type === "cashflow") {
      fetchPromises.push(fetchAllRows(supabase, 'account_cashflows', {
        select: 'account_name',
        filters: [(q) => q.in('account_name', accountNames)]
      }));
    }

    const responses = await Promise.all(fetchPromises);

    const txAccounts = responses[0].data ? responses[0].data.map((d) => d.account_name) : [];
    const eqAccounts = responses[1].data ? responses[1].data.map((d) => d.account_id) : [];
    const cfAccounts = (type === "cashflow" && responses[2]?.data) ? responses[2].data.map((d) => d.account_name) : [];

    const accounts = [...new Set([...txAccounts, ...eqAccounts, ...cfAccounts].filter(Boolean))];
    return { success: true, data: accounts };
  } catch (error) {
    console.error('[Stock] Error in getStockAccountNames:', error);
    throw error;
  }
}

/**
 * Add bulk stock transactions
 */
export async function addBulkStockTransactions(supabase, transactions) {
  try {
    if (!Array.isArray(transactions)) {
      throw new Error('Transactions must be an array');
    }

    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    // Validate all transactions belong to the user's accounts
    for (const txn of transactions) {
      if (txn.account_name && !accountNames.includes(txn.account_name)) {
        throw new Error(`Unauthorized: Account "${txn.account_name}" in one of the transactions does not belong to this user`);
      }
    }

    const { data, error } = await insertRows(supabase, 'stock_transactions', transactions);

    if (error) throw error;
    return { success: true, count: data.length };
  } catch (error) {
    console.error('[Stock] Error in addBulkStockTransactions:', error);
    throw error;
  }
}

/**
 * Get all stock master records
 */
export async function getStockMasterData(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'stock_master', {
      order: { column: 'stock_name', ascending: true }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getStockMasterData:', error);
    throw error;
  }
}

/**
 * Get distinct values for stock master fields
 */
export async function getStockMasterDistinctValues(supabase, field) {
  try {
    let data = [];
    if (field === 'broker_name') {
      const [txRes, epRes] = await Promise.all([
        fetchAllRows(supabase, 'stock_transactions', { select: 'broker_name' }),
        fetchAllRows(supabase, 'equity_positions', { select: 'broker' })
      ]);
      
      const txValues = txRes.data ? txRes.data.map(d => d.broker_name) : [];
      const epValues = epRes.data ? epRes.data.map(d => d.broker) : [];
      
      data = [...txValues, ...epValues].map(v => ({ [field]: v }));
    } else {
      const { data: result, error } = await fetchAllRows(supabase, 'stock_master', {
        select: field,
        filters: [(q) => q.neq(field, null)]
      });

      if (error) throw error;
      data = result;
    }

    const values = [
      ...new Set(
        data
          .map((d) => d[field])
          .filter(Boolean)
          .map((v) => {
            const s = String(v).trim();
            return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
          })
      ),
    ].sort();
    return { success: true, data: values };
  } catch (error) {
    console.error(`[Stock] Error in getStockMasterDistinctValues for ${field}:`, error);
    throw error;
  }
}

/**
 * Add stock master record
 */
export async function addStockMasterRecord(supabase, stockData) {
  try {
    const { data, error } = await insertRows(supabase, 'stock_master', stockData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addStockMasterRecord:', error);
    throw error;
  }
}

/**
 * Update stock master record
 */
export async function updateStockMasterRecord(supabase, symbol, stockData) {
  try {
    // 1. Get current stock name if we're changing it
    let oldStockName = null;
    if (stockData.stock_name) {
      const { data: current } = await fetchAllRows(supabase, 'stock_master', {
        select: 'stock_name',
        filters: [(q) => q.eq('symbol', symbol)],
        limit: 1
      });
      if (current && current.length > 0) oldStockName = current[0].stock_name;
    }

    // 2. Update stock_master
    const { data, error } = await updateRows(supabase, 'stock_master', stockData, { symbol });

    if (error) throw error;

    // 3. Update transactions if name changed
    if (oldStockName && stockData.stock_name && oldStockName !== stockData.stock_name) {
      await updateRows(supabase, 'stock_transactions', 
        { stock_name: stockData.stock_name }, 
        { stock_name: oldStockName }
      );
    }

    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateStockMasterRecord:', error);
    throw error;
  }
}

/**
 * Rename stock record (updates master and transactions)
 */
export async function renameStockRecord(supabase, oldSymbol, newDetails) {
  try {
    const { newStockName, newSymbol } = newDetails;

    // 1. Get old stock name first
    const { data: oldStocks, error: fetchError } = await fetchAllRows(supabase, 'stock_master', {
      select: 'stock_name',
      filters: [(q) => q.eq('symbol', oldSymbol)],
      limit: 1
    });

    if (fetchError) throw fetchError;
    if (!oldStocks || oldStocks.length === 0) throw new Error('Stock not found');
    const oldStockName = oldStocks[0].stock_name;

    // 2. Update stock_master
    const { error: masterError } = await updateRows(supabase, 'stock_master', 
      { stock_name: newStockName, symbol: newSymbol }, 
      { symbol: oldSymbol }
    );

    if (masterError) throw masterError;

    // 3. Update all transactions
    if (oldStockName !== newStockName) {
      const { error: txError } = await updateRows(supabase, 'stock_transactions', 
        { stock_name: newStockName }, 
        { stock_name: oldStockName }
      );
      
      if (txError) throw txError;
    }

    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in renameStockRecord:', error);
    throw error;
  }
}

/**
 * Get equity charges
 */
export async function getEquityCharges(supabase) {
  try {
    const accountNames = await getAccountNames(supabase);
    const filterByAccount = (q) => {
      if (!accountNames) return q;
      return q.in('account_name', accountNames);
    };

    const { data, error } = await fetchAllRows(supabase, 'equity_charges', {
      order: { column: 'fy', ascending: false },
      filters: [filterByAccount]
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getEquityCharges:', error);
    throw error;
  }
}

/**
 * Add equity charge
 */
export async function addEquityCharge(supabase, chargeData) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    if (chargeData.account_name && !accountNames.includes(chargeData.account_name)) {
      throw new Error(`Unauthorized: Account "${chargeData.account_name}" does not belong to this user`);
    }

    const { data, error } = await insertRows(supabase, 'equity_charges', chargeData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addEquityCharge:', error);
    throw error;
  }
}

/**
 * Update equity charge
 */
export async function updateEquityCharge(supabase, id, chargeData) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    const { data, error } = await updateRows(supabase, 'equity_charges', chargeData, (q) => q.eq('id', id).in('account_name', accountNames));

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Charge record not found or unauthorized');
    }
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateEquityCharge:', error);
    throw error;
  }
}

/**
 * Delete equity charge
 */
export async function deleteEquityCharge(supabase, id) {
  try {
    const accountNames = await getAccountNames(supabase);
    if (!accountNames || accountNames.length === 0) {
      throw new Error('Unauthorized: No accounts found for user');
    }

    const { error } = await deleteRows(supabase, 'equity_charges', (q) => q.eq('id', id).in('account_name', accountNames));

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteEquityCharge:', error);
    throw error;
  }
}

/**
 * Get recent searches
 */
export async function getRecentSearches(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'recent_searches', {
      order: { column: 'created_at', ascending: false },
      limit: 10
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getRecentSearches:', error);
    throw error;
  }
}

/**
 * Add or update recent search
 */
export async function addRecentSearch(supabase, stockName) {
  try {
    // 1. Check if exists
    const { data: existing, error: selErr } = await fetchAllRows(supabase, 'recent_searches', {
      filters: [(q) => q.eq('stock_name', stockName)],
      limit: 1
    });
    
    if (selErr) throw selErr;

    if (existing && existing.length > 0) {
      // Update timestamp
      const { error: updErr } = await updateRows(supabase, 'recent_searches', { created_at: new Date().toISOString() }, { id: existing[0].id });
      if (updErr) throw updErr;
    } else {
      // Insert new
      const { error: insErr } = await insertRows(supabase, 'recent_searches', { stock_name: stockName });
      if (insErr) throw insErr;
    }

    // 2. Keep only last 10
    const { data: all, error: allErr } = await fetchAllRows(supabase, 'recent_searches', {
      select: 'id',
      order: { column: 'created_at', ascending: false }
    });
    
    if (allErr) throw allErr;

    if (all && all.length > 10) {
      const extra = all.slice(10);
      const idsToDelete = extra.map(row => row.id);
      await deleteRows(supabase, 'recent_searches', (q) => q.in('id', idsToDelete));
    }

    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in addRecentSearch:', error);
    throw error;
  }
}

/**
 * Clear recent searches
 */
export async function clearRecentSearches(supabase) {
  try {
    const { error } = await deleteRows(supabase, 'recent_searches', (q) => q.not('id', 'is', null));

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in clearRecentSearches:', error);
    throw error;
  }
}

/**
 * Get all bonus/split records
 */
export async function getAllBonusSplits(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "bonus_split", {
      order: { column: "date", ascending: false }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getAllBonusSplits:', error);
    throw error;
  }
}

/**
 * Sync corporate actions into bonus_split
 */
export async function syncCorporateActions(supabase) {
  try {
    // 1. Fetch stock mapping
    const { data: mappingData, error: mappingError } = await fetchAllRows(supabase, "stock_mapping", {
      select: "stock_name, symbol_gs, symbol_ao"
    });
    if (mappingError) throw mappingError;

    const symbolMap = {};
    mappingData.forEach(m => {
      if (m.symbol_gs) symbolMap[m.symbol_gs] = m.stock_name;
      if (m.symbol_ao) symbolMap[m.symbol_ao] = m.stock_name;
    });

    // 2. Fetch corporate actions (Bonus/Split)
    const { data: actions, error: actionsError } = await fetchAllRows(supabase, "corporate_actions", {
      filters: [
        q => q.in("action_type", ["Bonus", "Split", "BONUS", "SPLIT"])
      ]
    });
    if (actionsError) throw actionsError;

    // 3. Fetch existing bonus_split to avoid duplicates
    const { data: existingRecords, error: existingError } = await fetchAllRows(supabase, "bonus_split", {
      select: "stock_name, date, ratio, type, source"
    });
    if (existingError) throw existingError;

    const existingSet = new Set(
      existingRecords.map(r => `${r.stock_name}|${r.date}|${r.ratio}|${r.type.toLowerCase()}|${r.source}`)
    );

    const newRecords = [];
    for (const action of actions) {
      let stockName = symbolMap[action.symbol] || action.stock_name;
      if (!stockName) continue;

      const date = action.record_date || action.ex_date;
      if (!date) continue;

      const normalizedType = action.action_type.charAt(0).toUpperCase() + action.action_type.slice(1).toLowerCase();

      const key = `${stockName}|${date}|${action.ratio}|${normalizedType.toLowerCase()}|${action.source}`;
      if (existingSet.has(key)) continue;

      newRecords.push({
        stock_name: stockName,
        date: date,
        type: normalizedType,
        ratio: action.ratio,
        status: "active",
        source: action.source
      });
    }

    if (newRecords.length > 0) {
      const { error: insertError } = await insertRows(supabase, "bonus_split", newRecords);
      if (insertError) throw insertError;
      return { success: true, count: newRecords.length };
    }

    return { success: true, count: 0 };
  } catch (error) {
    console.error('[Stock] Error in syncCorporateActions:', error);
    throw error;
  }
}

/**
 * Add bonus/split record
 */
export async function addBonusSplit(supabase, bonusSplitData) {
  try {
    const { data, error } = await insertRows(supabase, 'bonus_split', bonusSplitData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addBonusSplit:', error);
    throw error;
  }
}

/**
 * Update bonus/split record
 */
export async function updateBonusSplit(supabase, id, bonusSplitData) {
  try {
    const { data, error } = await updateRows(supabase, 'bonus_split', bonusSplitData, { id });

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateBonusSplit:', error);
    throw error;
  }
}

/**
 * Delete bonus/split record
 */
export async function deleteBonusSplit(supabase, id) {
  try {
    const { error } = await deleteRows(supabase, 'bonus_split', { id });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteBonusSplit:', error);
    throw error;
  }
}

/**
 * Get all stock mappings
 */
export async function getAllStockMappings(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "stock_mapping", {
      order: { column: "stock_name", ascending: true }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getAllStockMappings:', error);
    throw error;
  }
}

/**
 * Add stock mapping
 */
export async function addStockMapping(supabase, mappingData) {
  try {
    const { data, error } = await insertRows(supabase, 'stock_mapping', mappingData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addStockMapping:', error);
    throw error;
  }
}

/**
 * Update stock mapping
 */
export async function updateStockMapping(supabase, id, mappingData) {
  try {
    const { data, error } = await updateRows(supabase, 'stock_mapping', mappingData, { id });

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateStockMapping:', error);
    throw error;
  }
}

/**
 * Delete stock mapping
 */
export async function deleteStockMapping(supabase, id) {
  try {
    const { error } = await deleteRows(supabase, 'stock_mapping', { id });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteStockMapping:', error);
    throw error;
  }
}

/**
 * Get stock symbols (for suggestions)
 */
export async function getStockSymbols(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "stock_symbols", {
      order: { column: "name", ascending: true }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getStockSymbols:', error);
    throw error;
  }
}

/**
 * Get stock master with incomplete data
 */
export async function getIncompleteStockMaster(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "stock_master", {
      filters: [
        q => q.or("sector.is.null,industry.is.null,category.is.null,macro_sector.is.null,known_sector.is.null,basic_industry.is.null,sector.eq.,industry.eq.,category.eq.,macro_sector.eq.,known_sector.eq.,basic_industry.eq.")
      ],
      order: { column: "stock_name", ascending: true }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getIncompleteStockMaster:', error);
    throw error;
  }
}

/**
 * Get stock mapping with incomplete data
 */
export async function getIncompleteStockMapping(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "stock_mapping", {
      filters: [
        q => q.or("symbol_ao.is.null,symbol_gs.is.null,symbol_ao.eq.,symbol_gs.eq.")
      ],
      order: { column: "stock_name", ascending: true }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getIncompleteStockMapping:', error);
    throw error;
  }
}

/**
 * Apply bonus/split logic to transactions
 */
export async function applyBonusSplitAction(supabase, record) {
  try {
    const [x, y] = record.ratio.split(":").map(Number);
    if (!x || !y) throw new Error("Invalid ratio format");

    const { data: transactions, error } = await fetchAllRows(supabase, "stock_transactions", {
      filters: [q => q.eq("stock_name", record.stock_name)]
    });

    if (error) throw error;
    if (!transactions.length) throw new Error("No transactions found for this stock");

    const recordDate = new Date(record.date);

    for (const t of transactions) {
      const buyDate = new Date(t.buy_date);
      const sellDate = t.sell_date ? new Date(t.sell_date) : null;

      if (buyDate >= recordDate) continue;
      if (sellDate && sellDate < recordDate) continue;

      let newQty = t.quantity;
      let newBuy = t.buy_price;
      let newSell = t.sell_price;

      if (record.type === "Bonus") {
        newQty = t.quantity * (1 + x / y);
        newBuy = t.buy_price / (1 + x / y);
        newSell = (t.sell_price && t.sell_price > 0) ? t.sell_price / (1 + x / y) : null;
      } else if (record.type === "Split") {
        newQty = t.quantity * (x / y);
        newBuy = t.buy_price / (x / y);
        newSell = (t.sell_price && t.sell_price > 0) ? t.sell_price / (x / y) : null;
      }

      const { error: updErr } = await updateRows(supabase, "stock_transactions", 
        { quantity: newQty, buy_price: newBuy, sell_price: newSell }, 
        { id: t.id }
      );
      
      if (updErr) throw updErr;
    }

    // Mark all matching bonus_split records as inactive
    const { error: statusErr } = await updateRows(supabase, "bonus_split", 
      { status: "inactive" }, 
      (q) => q.match({
        stock_name: record.stock_name,
        date: record.date,
        type: record.type,
        ratio: record.ratio
      })
    );

    if (statusErr) throw statusErr;

    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in applyBonusSplitAction:', error);
    throw error;
  }
}

/**
 * Revert bonus/split logic from transactions
 */
export async function revertBonusSplitAction(supabase, record) {
  try {
    const [x, y] = record.ratio.split(":").map(Number);
    if (!x || !y) throw new Error("Invalid ratio format");

    const { data: transactions, error } = await fetchAllRows(supabase, "stock_transactions", {
      filters: [q => q.eq("stock_name", record.stock_name)]
    });

    if (error) throw error;
    if (!transactions.length) throw new Error("No transactions found for this stock");

    const recordDate = new Date(record.date);

    for (const t of transactions) {
      const buyDate = new Date(t.buy_date);
      const sellDate = t.sell_date ? new Date(t.sell_date) : null;

      if (buyDate >= recordDate) continue;
      if (sellDate && sellDate < recordDate) continue;

      let newQty = t.quantity;
      let newBuy = t.buy_price;
      let newSell = t.sell_price;

      if (record.type === "Bonus") {
        newQty = t.quantity / (1 + x / y);
        newBuy = t.buy_price * (1 + x / y);
        newSell = (t.sell_price && t.sell_price > 0) ? t.sell_price * (1 + x / y) : null;
      } else if (record.type === "Split") {
        newQty = t.quantity / (x / y);
        newBuy = t.buy_price * (x / y);
        newSell = (t.sell_price && t.sell_price > 0) ? t.sell_price * (x / y) : null;
      }

      const { error: updErr } = await updateRows(supabase, "stock_transactions", 
        { quantity: newQty, buy_price: newBuy, sell_price: newSell }, 
        { id: t.id }
      );
      
      if (updErr) throw updErr;
    }

    // Mark all matching bonus_split records as active
    const { error: statusErr } = await updateRows(supabase, "bonus_split", 
      { status: "active" }, 
      (q) => q.match({
        stock_name: record.stock_name,
        date: record.date,
        type: record.type,
        ratio: record.ratio
      })
    );

    if (statusErr) throw statusErr;

    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in revertBonusSplitAction:', error);
    throw error;
  }
}

/**
 * Apply bulk bonus/split logic
 */
export async function applyBulkBonusSplits(supabase, records) {
  try {
    const uniqueActions = [];
    const seen = new Set();
    for (const r of records) {
      const key = `${r.stock_name}|${r.date}|${r.type}|${r.ratio}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueActions.push(r);
      }
    }

    const results = [];
    for (const record of uniqueActions) {
      try {
        await applyBonusSplitAction(supabase, record);
        results.push({ stock_name: record.stock_name, success: true });
      } catch (error) {
        results.push({ stock_name: record.stock_name, success: false, error: error.message });
      }
    }
    return { success: true, results };
  } catch (error) {
    console.error('[Stock] Error in applyBulkBonusSplits:', error);
    throw error;
  }
}

/**
 * Revert bulk bonus/split logic
 */
export async function revertBulkBonusSplits(supabase, records) {
  try {
    const uniqueActions = [];
    const seen = new Set();
    for (const r of records) {
      const key = `${r.stock_name}|${r.date}|${r.type}|${r.ratio}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueActions.push(r);
      }
    }

    const results = [];
    for (const record of uniqueActions) {
      try {
        await revertBonusSplitAction(supabase, record);
        results.push({ stock_name: record.stock_name, success: true });
      } catch (error) {
        results.push({ stock_name: record.stock_name, success: false, error: error.message });
      }
    }
    return { success: true, results };
  } catch (error) {
    console.error('[Stock] Error in revertBulkBonusSplits:', error);
    throw error;
  }
}

/**
 * Update bulk bonus split status
 */
export async function updateBonusSplitStatusBulk(supabase, ids, status) {
  try {
    const { error } = await updateRows(supabase, "bonus_split", { status }, (q) => q.in("id", ids));

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in updateBonusSplitStatusBulk:', error);
    throw error;
  }
}

/**
 * Get all watchlists
 */
export async function getAllWatchlists(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "watchlists", {
      select: "list_number, list_name, stock_names"
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getAllWatchlists:', error);
    throw error;
  }
}

/**
 * Add a new watchlist
 */
export async function addWatchlist(supabase, watchlistData) {
  try {
    const { data, error } = await insertRows(supabase, 'watchlists', watchlistData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addWatchlist:', error);
    throw error;
  }
}

/**
 * Update an existing watchlist
 */
export async function updateWatchlist(supabase, list_number, watchlistData) {
  try {
    const { data, error } = await updateRows(supabase, 'watchlists', watchlistData, { list_number });

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateWatchlist:', error);
    throw error;
  }
}

/**
 * Get watchlist
 */
export async function getWatchlist(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'stock_watchlist', {
      order: { column: 'created_at', ascending: false }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getWatchlist:', error);
    throw error;
  }
}

/**
 * Add to watchlist
 */
export async function addToWatchlist(supabase, stockData) {
  try {
    const { data, error } = await insertRows(supabase, 'stock_watchlist', stockData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addToWatchlist:', error);
    throw error;
  }
}

/**
 * Remove from watchlist
 */
export async function removeFromWatchlist(supabase, id) {
  try {
    const { error } = await deleteRows(supabase, 'stock_watchlist', { id });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in removeFromWatchlist:', error);
    throw error;
  }
}

/**
 * Get equity positions
 */
export async function getEquityPositions(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'equity_positions');

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getEquityPositions:', error);
    throw error;
  }
}

/**
 * Delete equity positions
 */
export async function deleteEquityPositions(supabase, ids) {
  try {
    const { error } = await deleteRows(supabase, 'equity_positions', (q) => q.in('id', ids));

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteEquityPositions:', error);
    throw error;
  }
}

/**
 * Get stock transactions by dates
 */
export async function getStockTransactionsByDates(supabase, dates) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'stock_transactions', {
      select: 'id, stock_name, quantity, buy_price, buy_date, account_name, account_type',
      filters: [(q) => q.in('buy_date', dates)]
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getStockTransactionsByDates:', error);
    throw error;
  }
}

/**
 * Get Cashflow Data (Deposits, Withdrawals, Dividends)
 */
export async function getCashflowData(supabase, filters = {}) {
  try {
    const queryFilters = [];
    
    if (filters.transaction_type) {
      const types = Array.isArray(filters.transaction_type)
        ? filters.transaction_type
        : (typeof filters.transaction_type === 'string' && filters.transaction_type.includes(',')
            ? filters.transaction_type.split(',').map(t => t.trim())
            : [filters.transaction_type]);
      
      if (types.length > 1) {
        queryFilters.push(q => q.in("transaction_type", types));
      } else {
        queryFilters.push(q => q.eq("transaction_type", types[0]));
      }
    }

    if (filters.account_name && filters.account_name !== 'ALL') {
      queryFilters.push(q => q.eq("account_name", filters.account_name));
    }

    if (filters.stock_name) {
      queryFilters.push(q => q.ilike("stock_name", `%${filters.stock_name}%`));
    }

    if (filters.startDate) {
      queryFilters.push(q => q.gte("date", filters.startDate));
    }

    if (filters.endDate) {
      queryFilters.push(q => q.lte("date", filters.endDate));
    }

    const { data, error } = await fetchAllRows(supabase, "account_cashflows", {
      select: "*",
      filters: queryFilters,
      order: { column: "date", ascending: false }
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getCashflowData:', error);
    throw error;
  }
}

/**
 * Add Cashflow record
 */
export async function addCashflow(supabase, cashflowData) {
  try {
    const { data, error } = await insertRows(supabase, "account_cashflows", cashflowData);

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in addCashflow:', error);
    throw error;
  }
}

/**
 * Update Cashflow record
 */
export async function updateCashflow(supabase, id, cashflowData) {
  try {
    const { data, error } = await updateRows(supabase, "account_cashflows", cashflowData, { id });

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateCashflow:', error);
    throw error;
  }
}

/**
 * Delete Cashflow record
 */
export async function deleteCashflow(supabase, id) {
  try {
    const { error } = await deleteRows(supabase, "account_cashflows", { id });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteCashflow:', error);
    throw error;
  }
}

/**
 * Sync Dividend Events from corporate_actions
 */
export async function syncDividendEvents(supabase) {
  try {
    const { data: actions, error: actionsError } = await fetchAllRows(supabase, "corporate_actions", {
      filters: [q => q.in("action_type", ["Dividend", "DIVIDEND"])]
    });
    if (actionsError) throw actionsError;

    if (!actions || actions.length === 0) return { success: true, count: 0 };

    const actionMap = new Map();
    actions.forEach((action) => {
      const key = `${action.symbol}|${action.ex_date}|${action.dividend_amount}`;
      const existing = actionMap.get(key);
      if (!existing || (action.source === "NSE" && existing.source !== "NSE")) {
        actionMap.set(key, action);
      }
    });
    const uniqueActions = Array.from(actionMap.values());

    const { data: existingEvents, error: existingError } = await fetchAllRows(supabase, "dividend_events", {
      select: "symbol, ex_date, dividend_amount"
    });
    if (existingError) throw existingError;

    const existingSet = new Set(
      existingEvents.map(e => `${e.symbol}|${e.ex_date}|${e.dividend_amount}`)
    );

    const newRecords = uniqueActions
      .filter(action => !existingSet.has(`${action.symbol}|${action.ex_date}|${action.dividend_amount}`))
      .map(action => ({
        symbol: action.symbol,
        company_name: action.company_name,
        ex_date: action.ex_date,
        record_date: action.record_date,
        payment_date: action.payment_date,
        dividend_amount: action.dividend_amount,
        purpose: action.purpose,
        source: action.source,
        source_url: action.source_url,
        stock_name: action.stock_name,
        status: "active"
      }));

    if (newRecords.length > 0) {
      const { error: insertError } = await insertRows(supabase, "dividend_events", newRecords);
      if (insertError) throw insertError;
    }

    return { success: true, count: newRecords.length };
  } catch (error) {
    console.error('[Stock] Error in syncDividendEvents:', error);
    throw error;
  }
}

/**
 * Update Dividend Event
 */
export async function updateDividendEvent(supabase, id, eventData) {
  try {
    const { data, error } = await updateRows(supabase, "dividend_events", eventData, { id });

    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('[Stock] Error in updateDividendEvent:', error);
    throw error;
  }
}

/**
 * Delete Dividend Event
 */
export async function deleteDividendEvent(supabase, id) {
  try {
    const { error } = await deleteRows(supabase, "dividend_events", { id });

    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('[Stock] Error in deleteDividendEvent:', error);
    throw error;
  }
}

/**
 * Apply Active Dividend Events to Transactions
 */
export async function applyDividendEvents(supabase) {
  try {
    // 1. Fetch relevant stock transactions (open OR sold after ex_date)
    // We fetch all to be safe, then filter in memory
    const { data: transactions, error: txError } = await fetchAllRows(supabase, "stock_transactions", {
      select: "stock_name, account_name, quantity, buy_date, sell_date"
    });
    if (txError) throw txError;

    // 2. Fetch all active dividend events
    const { data: activeEvents, error: evError } = await fetchAllRows(supabase, "dividend_events", {
      filters: [q => q.ilike("status", "active")]
    });
    if (evError) throw evError;

    if (!activeEvents || activeEvents.length === 0) {
      return { success: true, count: 0, message: "No active dividend events to apply." };
    }

    // 3. Fetch existing dividend cashflows to avoid duplicates
    const { data: existingCashflows, error: cfError } = await fetchAllRows(supabase, "account_cashflows", {
      filters: [q => q.eq("transaction_type", "dividend")]
    });
    if (cfError) throw cfError;

    const existingCFSet = new Set(
      existingCashflows.map(cf => `${cf.stock_name}|${cf.account_name}|${cf.date}|${cf.amount}`)
    );

    // 4. Fetch stock mappings to handle symbols
    const { data: mappingData } = await fetchAllRows(supabase, "stock_mapping", {
      select: "stock_name, symbol_gs, symbol_ao"
    });
    const symbolToNameMap = {};
    if (mappingData) {
      mappingData.forEach(m => {
        if (m.symbol_gs) symbolToNameMap[m.symbol_gs] = m.stock_name;
        if (m.symbol_ao) symbolToNameMap[m.symbol_ao] = m.stock_name;
      });
    }

    const newCashflows = [];
    const appliedEventIds = new Set();
    const stockAccountGroups = {};
    transactions.forEach(tx => {
      if (!tx.stock_name || !tx.account_name || !tx.quantity || !tx.buy_date) return;
      const groupKey = `${tx.stock_name}|${tx.account_name}`;
      if (!stockAccountGroups[groupKey]) stockAccountGroups[groupKey] = [];
      stockAccountGroups[groupKey].push(tx);
    });

    for (const groupKey in stockAccountGroups) {
      const [stockName, accountName] = groupKey.split("|");
      const groupTxs = stockAccountGroups[groupKey];

      const relevantEvents = activeEvents.filter(ev => {
        const eventStockName = ev.stock_name || symbolToNameMap[ev.symbol] || ev.symbol;
        return (eventStockName === stockName);
      });

      for (const ev of relevantEvents) {
        if (!ev.ex_date || !ev.dividend_amount) continue;
        
        // Filter transactions held ON the ex-date
        const totalQty = groupTxs
          .filter(tx => {
            const boughtBeforeEx = tx.buy_date < ev.ex_date;
            const notSoldYet = !tx.sell_date;
            const soldOnOrAfterEx = tx.sell_date && tx.sell_date >= ev.ex_date;
            return boughtBeforeEx && (notSoldYet || soldOnOrAfterEx);
          })
          .reduce((sum, tx) => sum + (parseFloat(tx.quantity) || 0), 0);

        if (totalQty <= 0) continue;
        const amount = parseFloat((totalQty * ev.dividend_amount).toFixed(2));
        if (amount <= 0) continue;

        const key = `${stockName}|${accountName}|${ev.ex_date}|${amount}`;
        if (!existingCFSet.has(key)) {
          newCashflows.push({
            account_name: accountName,
            transaction_type: "dividend",
            amount: amount,
            date: ev.ex_date,
            stock_name: stockName,
            notes: "Auto-generated from dividend events"
          });
          existingCFSet.add(key);
          appliedEventIds.add(ev.id);
        } else {
          appliedEventIds.add(ev.id);
        }
      }
    }

    if (newCashflows.length > 0) {
      const { error: insertError } = await insertRows(supabase, "account_cashflows", newCashflows);
      if (insertError) throw insertError;
      
      const idsToInactivate = Array.from(appliedEventIds);
      if (idsToInactivate.length > 0) {
        const { error: updateError } = await updateRows(supabase, "dividend_events", { status: "inactive" }, (q) => q.in("id", idsToInactivate));
        if (updateError) throw updateError;
      }

      return { success: true, count: newCashflows.length };
    } else {
      return { success: true, count: 0, message: "No new dividends to generate." };
    }
  } catch (error) {
    console.error('[Stock] Error in applyDividendEvents:', error);
    throw error;
  }
}

/**
 * Get Dividend Events
 */
export async function getDividendEvents(supabase) {
  try {
    const { data, error } = await fetchAllRows(supabase, "dividend_events", {
      order: { column: "ex_date", ascending: false }
    });
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getDividendEvents:', error);
    throw error;
  }
}

/**
 * Get Indices (NIFTY 50, SENSEX, etc.)
 */
export async function getMarketIndices(supabase, sourceTable = 'market_indices') {
  try {
    const indexNames = ["NIFTY 50", "SENSEX", "MIDCAP 100", "SMALLCAP 250"];
    
    // Try primary source
    let { data, error } = await fetchAllRows(supabase, sourceTable, {
      select: 'stock_name, cmp, lcp, updated_at',
      filters: [(q) => q.in('stock_name', indexNames)]
    });

    // Fallback if no data and we didn't already try stock_master
    if ((!data || data.length === 0) && sourceTable !== 'stock_master') {
      const fallback = await fetchAllRows(supabase, 'stock_master', {
        select: 'stock_name, cmp, lcp, updated_at',
        filters: [(q) => q.in('stock_name', indexNames)]
      });
      
      if (!fallback.error && fallback.data && fallback.data.length > 0) {
        data = fallback.data;
      }
    }

    if (error && (!data || data.length === 0)) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in getMarketIndices:', error);
    throw error;
  }
}

/**
 * Search stocks in stock_master
 */
export async function searchStockMaster(supabase, query, limit = 10) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'stock_master', {
      select: 'stock_name, symbol',
      filters: [(q) => q.ilike('stock_name', `%${query}%`)],
      limit: limit
    });

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('[Stock] Error in searchStockMaster:', error);
    throw error;
  }
}

/**
 * Get CMP for a specific stock
 * @param {Object} supabase - Supabase client
 * @param {string} stockName - Name of the stock
 * @param {string} priceSource - Table to fetch from (stock_master|stock_mapping)
 * @returns {Promise<number|null>}
 */
export const getStockCMP = async (supabase, stockName, priceSource = 'stock_master') => {
  try {
    const table = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';
    const { data, error } = await fetchAllRows(supabase, table, {
      select: 'cmp',
      filters: [(q) => q.eq('stock_name', stockName)],
      limit: 1
    });

    if (!error && data && data.length > 0) {
      return data[0].cmp;
    }

    if (table !== 'stock_master') {
      const { data: fallback, error: fallbackError } = await fetchAllRows(supabase, 'stock_master', {
        select: 'cmp',
        filters: [(q) => q.eq('stock_name', stockName)],
        limit: 1
      });
      if (!fallbackError && fallback && fallback.length > 0) {
        return fallback[0].cmp;
      }
    }
    return null;
  } catch (error) {
    console.error('[Stock Service] Error fetching CMP:', error);
    return null;
  }
};
 
