/**
 * Stock Service
 * Handles open/closed stock holdings, ETF data, and portfolio aggregations
 */

import { fetchAllRows } from '../db/queries.js';

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
 * Get open stock holdings grouped by stock name
 */
export async function getOpenStockData(supabase, userId) {
  console.log(`[Stock] Fetching open stock holdings for user: ${userId}`);

  try {
    // Fetch open transactions for Free/Regular accounts
    const { data: transactions, error: txnError } = await fetchAllRows(
      supabase,
      'stock_transactions',
      {
        select: 'id, stock_name, quantity, buy_price, buy_date, account_name, account_type',
        filters: [
          (q) => q.is('sell_date', null),
          (q) => q.in('account_type', ['Free', 'Regular']),
        ],
      }
    );

    if (txnError) throw txnError;

    // Fetch stock master for CMP/LCP
    const { data: masters, error: masterError } = await fetchAllRows(
      supabase,
      'stock_master',
      {
        select: 'stock_name, cmp, lcp, category, sector',
      }
    );

    if (masterError) throw masterError;

    const masterMap = {};
    const categoryMap = {};
    const sectorMap = {};

    (masters || []).forEach((m) => {
      const stockName = String(m.stock_name).trim();
      masterMap[stockName] = {
        cmp: toNumber(m.cmp),
        lcp: toNumber(m.lcp),
      };
      if (m.category) categoryMap[stockName] = m.category;
      if (m.sector) sectorMap[stockName] = m.sector;
    });

    // Group by stock name
    const grouped = {};
    (transactions || []).forEach((txn) => {
      const stockName = String(txn.stock_name).trim();
      if (!grouped[stockName]) {
        grouped[stockName] = {
          stock_name: stockName,
          transactions: [],
          cmp: masterMap[stockName]?.cmp || 0,
          lcp: masterMap[stockName]?.lcp || 0,
          category: categoryMap[stockName] || null,
          sector: sectorMap[stockName] || null,
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
        changePct: changePct,
        invested: invested,
        marketValue: marketValue,
        urp: urp,
        urpPct: urpPct,
        xirr: xirr,
        transactions: group.transactions,
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
                txnSum + toNumber(txn.quantity) * (h.livePrice - h.lcp),
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
export async function getClosedStockData(supabase, userId) {
  console.log(`[Stock] Fetching closed stock holdings for user: ${userId}`);

  try {
    // Fetch closed transactions
    const { data: transactions, error: txnError } = await fetchAllRows(
      supabase,
      'stock_transactions',
      {
        select:
          'id, stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type',
        filters: [(q) => q.not('sell_date', 'is', null)],
      }
    );

    if (txnError) throw txnError;

    // Fetch stock master
    const { data: masters, error: masterError } = await fetchAllRows(
      supabase,
      'stock_master',
      {
        select: 'stock_name, cmp, lcp',
      }
    );

    if (masterError) throw masterError;

    const masterMap = {};
    (masters || []).forEach((m) => {
      const stockName = String(m.stock_name).trim();
      masterMap[stockName] = {
        cmp: toNumber(m.cmp),
        lcp: toNumber(m.lcp),
      };
    });

    // Group by stock name
    const grouped = {};
    (transactions || []).forEach((txn) => {
      const stockName = String(txn.stock_name).trim();
      if (!grouped[stockName]) {
        grouped[stockName] = {
          stock_name: stockName,
          transactions: [],
          cmp: masterMap[stockName]?.cmp || 0,
          lcp: masterMap[stockName]?.lcp || 0,
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
export async function getETFData(supabase, userId) {
  console.log(`[Stock] Fetching ETF data for user: ${userId}`);

  try {
    const { data: transactions, error: txnError } = await fetchAllRows(
      supabase,
      'stock_transactions',
      {
        select:
          'id, stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type',
        filters: [(q) => q.ilike('account_type', 'etf')],
      }
    );

    if (txnError) throw txnError;

    // Fetch stock master
    const { data: masters, error: masterError } = await fetchAllRows(
      supabase,
      'stock_master',
      {
        select: 'stock_name, cmp, lcp',
      }
    );

    if (masterError) throw masterError;

    const masterMap = {};
    (masters || []).forEach((m) => {
      const stockName = String(m.stock_name).trim();
      masterMap[stockName] = {
        cmp: toNumber(m.cmp),
        lcp: toNumber(m.lcp),
      };
    });

    // Group by stock name
    const grouped = {};
    (transactions || []).forEach((txn) => {
      const stockName = String(txn.stock_name).trim();
      if (!grouped[stockName]) {
        grouped[stockName] = {
          stock_name: stockName,
          transactions: [],
          cmp: masterMap[stockName]?.cmp || 0,
          lcp: masterMap[stockName]?.lcp || 0,
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

      holdings.push({
        stock_name: group.stock_name,
        transactions: group.transactions,
        openHoldings: {
          invested: openInvested,
          marketValue: openMarketValue,
          quantity: openQty,
          cmp: cmp,
          lcp: lcp,
        },
        closedHoldings: {
          invested: closedInvested,
          value: closedValue,
          profit: closedValue - closedInvested,
        },
      });
    });

    // Calculate summary for open holdings
    const summary = {
      invested: holdings.reduce((sum, h) => sum + h.openHoldings.invested, 0),
      currentValue: holdings.reduce((sum, h) => sum + h.openHoldings.marketValue, 0),
      dayChange: holdings.reduce((sum, h) => sum + (h.openHoldings.quantity * (h.openHoldings.cmp - h.openHoldings.lcp)), 0),
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
export async function getPortfolioData(supabase, userId) {
  console.log(`[Stock] Fetching portfolio data for user: ${userId}`);

  try {
    const [
      { data: transactions, error: txnError },
      { data: masters, error: masterError },
      { data: chargesData, error: chargesError },
    ] = await Promise.all([
      fetchAllRows(supabase, 'stock_transactions', {
        select:
          'id, stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type',
      }),
      fetchAllRows(supabase, 'stock_master', {
        select: 'stock_name, cmp, lcp, category, sector',
      }),
      fetchAllRows(supabase, 'equity_charges', {
        select: 'account_name, year, fy, other_charges, dp_charges',
      }),
    ]);

    if (txnError || masterError || chargesError) {
      throw new Error('Failed to fetch portfolio data');
    }

    const masterMap = {};
    (masters || []).forEach((m) => {
      const stockName = String(m.stock_name).trim();
      masterMap[stockName] = {
        cmp: toNumber(m.cmp),
        lcp: toNumber(m.lcp),
        category: m.category,
        sector: m.sector,
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
      const cmp = masterMap[String(txn.stock_name).trim()]?.cmp || 0;
      const lcp = masterMap[String(txn.stock_name).trim()]?.lcp || 0;

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
        acc[stockName] = {
          stock_name: stockName,
          quantity: 0,
          invested: 0,
          currentValue: 0,
          dayChange: 0,
          cmp: masterMap[stockName]?.cmp || 0,
          lcp: masterMap[stockName]?.lcp || 0,
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