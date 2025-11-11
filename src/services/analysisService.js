import { fetchAllRows } from '../db/queries.js';
import { supabase } from '../db/supabaseClient.js';

const toNumber = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date.toISOString();
};

const normalizeType = (value = '') => {
  const lowered = value.toLowerCase();
  const types = ['buy', 'purchase', 'sip', 'contribution', 'sell', 'redeem', 'switch out', 'switch in', 'withdraw', 'charges', 'interest'];
  return types.find((label) => lowered.includes(label)) || lowered;
};

const MF_BUY_KEYWORDS = [
  'buy',
  'purchase',
  'sip',
  'switch in',
  'switch-in',
  'contribution',
  'allotment',
  'dividend',
  'stp in',
  'stp-in',
];

const MF_FIFO_SALE_KEYWORDS = [
  'sell',
  'redeem',
  'redeemption',
  'withdraw',
  'withdrawal',
  'switch out',
  'switch-out',
  'switch to',
  'switch-to',
  'stp out',
  'stp-out',
  'charges',
  'exit',
  'migration',
  'transfer',
  'payout',
];

const normalizeMfTransactionType = (rawType, units) => {
  const rawText = String(rawType ?? '').trim().toLowerCase();
  const normalizedUnits = Number.isFinite(units) ? units : null;

  if (!rawText) {
    if (normalizedUnits !== null) {
      if (normalizedUnits < 0) return 'sell';
      if (normalizedUnits > 0) return 'buy';
    }
    return null;
  }

  const normalizedText = rawText.replace(/\s+/g, ' ');

  if (MF_FIFO_SALE_KEYWORDS.some((keyword) => normalizedText.includes(keyword))) {
    return 'sell';
  }

  if (MF_BUY_KEYWORDS.some((keyword) => normalizedText.includes(keyword))) {
    return 'buy';
  }

  if (normalizedText.includes('charge') || normalizedText.includes('fee') || normalizedText.includes('tax')) {
    return 'charges';
  }

  if (normalizedUnits !== null) {
    if (normalizedUnits < 0) return 'sell';
    if (normalizedUnits > 0) return 'buy';
  }

  return null;
};

const parseMfTransactionDate = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const epochDate = new Date(numeric);
    if (!Number.isNaN(epochDate.getTime())) {
      return epochDate;
    }
  }
  return null;
};

const sortLotsFifo = (lots) => {
  lots.sort((a, b) => {
    const orderDiff = (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
    if (Math.abs(orderDiff) > 1e-8) {
      return orderDiff;
    }
    return (a.sequence ?? 0) - (b.sequence ?? 0);
  });
};

const consumeLots = (lots, unitsToRemove) => {
  let remaining = unitsToRemove;
  const consumed = [];
  sortLotsFifo(lots);

  while (remaining > 1e-8 && lots.length) {
    const currentLot = lots[0];
    if (!currentLot || currentLot.units <= 1e-8) {
      lots.shift();
      continue;
    }

    const available = currentLot.units;
    const deduction = Math.min(remaining, available);
    const costPerUnit = available > 1e-8 ? currentLot.cost / available : currentLot.nav || 0;
    const costPortion = deduction * costPerUnit;

    consumed.push({
      units: deduction,
      cost: costPortion,
      buyDate: currentLot.date ? currentLot.date.toISOString() : null,
      nav: currentLot.nav,
      costPerUnit,
      accountName: currentLot.accountName,
      originalLot: currentLot,
    });

    currentLot.units -= deduction;
    currentLot.cost -= costPortion;

    if (currentLot.units <= 1e-8 || currentLot.cost <= 1e-8) {
      lots.shift();
    }

    remaining -= deduction;
  }

  return { consumed, remaining };
};

const XIRR_MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365;

const calculateXirr = (flows) => {
  if (!flows || flows.length < 2) return 0;
  const cashflows = flows
    .map((cf) => ({ amount: Number(cf.amount), date: new Date(cf.date) }))
    .filter(
      (cf) =>
        Number.isFinite(cf.amount) &&
        cf.amount !== 0 &&
        cf.date instanceof Date &&
        !Number.isNaN(cf.date.valueOf()),
    )
    .sort((a, b) => a.date - b.date);

  if (!cashflows.length) return 0;

  const baseDate = cashflows[0].date;
  const npv = (rate) =>
    cashflows.reduce(
      (acc, cf) => acc + cf.amount / Math.pow(1 + rate, (cf.date - baseDate) / XIRR_MS_PER_YEAR),
      0,
    );

  let low = -0.9999;
  let high = 100;
  let mid = 0;

  for (let i = 0; i < 100; i += 1) {
    mid = (low + high) / 2;
    const value = npv(mid);
    if (Math.abs(value) < 1e-6) {
      return mid * 100;
    }
    if (value > 0) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return mid * 100;
};

export async function getAnalysisDashboard() {
  try {
    const [
      { data: stockTxns },
      { data: stockMaster },
      { data: mfTxns },
      { data: fundMaster },
      { data: ppfTxns },
      { data: epfTxns },
      { data: npsTxns },
    ] = await Promise.all([
      fetchAllRows(supabase, 'stock_transactions', {
        select: 'stock_name, quantity, buy_price, sell_date, account_name, account_type, buy_date',
      }),
      fetchAllRows(supabase, 'stock_master', {
        select: 'stock_name, cmp',
      }),
      fetchAllRows(supabase, 'mf_transactions', {
        select: 'fund_short_name, account_name, transaction_type, date, units, nav',
        chunkSize: 2000,
      }),
      fetchAllRows(supabase, 'fund_master', {
        select: 'fund_short_name, cmp',
      }),
      fetchAllRows(supabase, 'ppf_transactions', {
        select: 'account_name, amount, transaction_type',
      }),
      fetchAllRows(supabase, 'epf_transactions', {
        select: 'employee_share, employer_share, pension_share',
      }),
      fetchAllRows(supabase, 'nps_transactions', {
        select: 'account_name, units, nav, transaction_type',
      }),
    ]);

    const cmpMap = new Map((stockMaster || []).map((m) => [m.stock_name, toNumber(m.cmp)]));
    const fundCmpMap = new Map((fundMaster || []).map((f) => [f.fund_short_name, toNumber(f.cmp)]));

    // Account-wise aggregation
    const accountTotals = new Map();

    const addToAccount = (accountName, invested, marketValue, assetType = '') => {
      const normalizedName = (accountName || '').trim();
      if (normalizedName.toUpperCase() === 'BDM') {
        return;
      }

      const key = normalizedName || 'Other Accounts';
      if (!accountTotals.has(key)) {
        accountTotals.set(key, { invested: 0, marketValue: 0, breakdown: {} });
      }

      const account = accountTotals.get(key);
      account.invested += invested;
      account.marketValue += marketValue;

      const typeKey = assetType ? assetType.trim() : 'Uncategorized';
      if (!account.breakdown[typeKey]) {
        account.breakdown[typeKey] = { invested: 0, marketValue: 0 };
      }
      account.breakdown[typeKey].invested += invested;
      account.breakdown[typeKey].marketValue += marketValue;
    };

    // Stocks
    const stockAccountMap = new Map();
    (stockTxns || []).forEach((txn) => {
      const accountName = txn.account_name?.trim();
      if (!stockAccountMap.has(accountName)) {
        stockAccountMap.set(accountName, []);
      }
      stockAccountMap.get(accountName).push(txn);
    });

    stockAccountMap.forEach((txns, accountName) => {
            const stocks = txns.filter((t) => !t.sell_date && t.account_type !== 'ETF');
      const etfs = txns.filter((t) => !t.sell_date && t.account_type === 'ETF');

      const sumTotals = (list) => {
        return list.reduce(
          (acc, txn) => {
            const quantity = toNumber(txn.quantity);
            const invested = quantity * toNumber(txn.buy_price);
            const cmp = cmpMap.get(txn.stock_name) || 0;
            return {
              invested: acc.invested + invested,
              marketValue: acc.marketValue + quantity * cmp,
            };
          },
          { invested: 0, marketValue: 0 }
        );
      };

      const stockTotals = sumTotals(stocks);
      if (stockTotals.invested > 0 || stockTotals.marketValue > 0) {
        addToAccount(accountName, stockTotals.invested, stockTotals.marketValue, 'Equity');
      }

      const etfTotals = sumTotals(etfs);
      if (etfTotals.invested > 0 || etfTotals.marketValue > 0) {
        addToAccount(accountName, etfTotals.invested, etfTotals.marketValue, 'ETF');
      }
    });

    // MF
    const mfAccountMap = new Map();
    (mfTxns || []).forEach((txn) => {
      const accountName = txn.account_name?.trim();
      if (!mfAccountMap.has(accountName)) {
        mfAccountMap.set(accountName, []);
      }
      mfAccountMap.get(accountName).push(txn);
    });

    mfAccountMap.forEach((txns, accountName) => {
      let invested = 0;
      let marketValue = 0;

      const processMFLots = (list) => {
        const lots = new Map();
        list.forEach((txn) => {
          const key = txn.fund_short_name;
          if (!lots.has(key)) {
            lots.set(key, []);
          }
          lots.get(key).push(txn);
        });

        lots.forEach((entries) => {
          const fifo = [];
          entries
            .slice()
            .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
            .forEach((txn) => {
              const units = toNumber(txn.units);
              const nav = toNumber(txn.nav);
              const type = String(txn.transaction_type || '').toLowerCase();
              if (type.includes('buy') || type.includes('sip')) {
                fifo.push({ units, nav });
              } else if (type.includes('sell') || type.includes('redeem')) {
                let remaining = Math.abs(units);
                while (remaining > 0 && fifo.length) {
                  const lot = fifo[0];
                  const consumed = Math.min(remaining, lot.units);
                  lot.units -= consumed;
                  remaining -= consumed;
                  if (lot.units <= 1e-6) fifo.shift();
                }
              }
            });

          fifo.forEach((lot) => {
            const cmp = fundCmpMap.get(entries[0].fund_short_name) || 0;
            invested += lot.units * lot.nav;
            marketValue += lot.units * cmp;
          });
        });
      };

      processMFLots(txns);
      addToAccount(accountName, invested, marketValue, 'Mutual Fund');
    });

    // PPF
    const ppfAccountMap = new Map();
    (ppfTxns || []).forEach((txn) => {
      const accountName = txn.account_name?.trim();
      if (!ppfAccountMap.has(accountName)) {
        ppfAccountMap.set(accountName, []);
      }
      ppfAccountMap.get(accountName).push(txn);
    });

    ppfAccountMap.forEach((txns, accountName) => {
      let invested = 0;
      txns.forEach((txn) => {
        const amount = toNumber(txn.amount);
        const type = String(txn.transaction_type || '').toLowerCase();
        if (type.includes('deposit')) {
          invested += amount;
        }
      });
      // For PPF, market value is invested + interest, but simplify to invested for now
      addToAccount(accountName, invested, invested, 'PPF');
    });

    // EPF (no account_name, so Other Accounts)
    let epfInvested = 0;
    (epfTxns || []).forEach((txn) => {
      epfInvested += toNumber(txn.employee_share) + toNumber(txn.employer_share) + toNumber(txn.pension_share);
    });
    addToAccount(null, epfInvested, epfInvested, 'EPF');

    // NPS
    const npsAccountMap = new Map();
    (npsTxns || []).forEach((txn) => {
      const accountName = txn.account_name?.trim();
      if (!npsAccountMap.has(accountName)) {
        npsAccountMap.set(accountName, []);
      }
      npsAccountMap.get(accountName).push(txn);
    });

    npsAccountMap.forEach((txns, accountName) => {
      let invested = 0;
      let marketValue = 0;
      txns.forEach((txn) => {
        const units = toNumber(txn.units);
        const nav = toNumber(txn.nav);
        const type = String(txn.transaction_type || '').toLowerCase();
        if (type.includes('buy')) {
          invested += units * nav;
          marketValue += units * nav; // simplify, use nav as cmp
        }
      });
      addToAccount(accountName, invested, marketValue, 'NPS');
    });

    const totalOtherAccounts = accountTotals.get('Other Accounts');
    if (totalOtherAccounts) {
      accountTotals.delete('Other Accounts');
    }

    const accountWise = [];
    accountTotals.forEach((totals, accountName) => {
      if (totals.invested > 0 || totals.marketValue > 0) {
        accountWise.push({
          account_name: accountName,
          total_invested: totals.invested,
          total_market_value: totals.marketValue,
          breakdown: totals.breakdown,
          profit: totals.marketValue - totals.invested,
          profitPercent: totals.invested > 0 ? ((totals.marketValue - totals.invested) / totals.invested) * 100 : 0,
        });
      }
    });

    const otherAccounts = totalOtherAccounts
      ? {
          total_invested: totalOtherAccounts.invested,
          total_market_value: totalOtherAccounts.marketValue,
          breakdown: totalOtherAccounts.breakdown,
        }
      : { total_invested: 0, total_market_value: 0, breakdown: {} };

    // Top stocks
    const stockData = new Map();
    (stockTxns || []).forEach((txn) => {
      const stockName = txn.stock_name;
      if (!stockData.has(stockName)) {
        stockData.set(stockName, []);
      }
      stockData.get(stockName).push(txn);
    });

    const stocks = [];
    stockData.forEach((txns, stockName) => {
      const openTxns = txns.filter((txn) => !txn.sell_date);

      let invested = 0;
      let marketValue = 0;
      const cmp = cmpMap.get(stockName) || 0;
      openTxns.forEach((txn) => {
        const quantity = toNumber(txn.quantity);
        const price = toNumber(txn.buy_price);
        invested += quantity * price;
        marketValue += quantity * cmp;
      });

      if (openTxns.length > 0) {
        const profit = marketValue - invested;
        const percent = invested > 0 ? (profit / invested) * 100 : 0;
        stocks.push({
          name: stockName,
          invested,
          marketValue,
          profit,
          percent,
        });
      }
    });

    const gainers = stocks.filter((s) => s.profit > 0).sort((a, b) => b.profit - a.profit).slice(0, 5);
    const losers = stocks.filter((s) => s.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 5);

    // Enrich stocks with absReturnPct for profit filter
    const enrichedStocks = stocks.map((stock) => ({
      ...stock,
      absReturnPct: stock.percent, // for backward compatibility with absReturnPct
    }));

    return {
      accountWise,
      otherAccounts,
      topGainers: gainers,
      topLosers: losers,
      totalStocks: stocks.length,
      openEquityPositions: {
        stocks: enrichedStocks,
      },
    };
  } catch (error) {
    console.error('Analysis Dashboard error:', error);
    throw error;
  }
}

export async function getAnalysisSummary() {
  try {
    const [
      { data: stockTxns, error: stockError },
      { data: stockMaster, error: stockMasterError },
      { data: mfTxns, error: mfError },
      { data: fundMaster, error: fundMasterError },
    ] = await Promise.all([
      fetchAllRows(supabase, 'stock_transactions', {
        select: 'stock_name, quantity, buy_price, buy_date, sell_date, sell_price, account_name, account_type',
      }),
      fetchAllRows(supabase, 'stock_master', {
        select: 'stock_name, cmp, lcp, sector, category',
      }),
      fetchAllRows(supabase, 'mf_transactions', {
        select: 'fund_short_name, account_name, transaction_type, date, units, nav',
        chunkSize: 2000,
      }),
      fetchAllRows(supabase, 'fund_master', {
        select: 'fund_short_name, cmp, lcp, category, amc_name',
      }),
    ]);

    if (stockError) {
      console.error('[AnalysisSummary] stock_transactions fetch error:', stockError);
    }
    if (stockMasterError) {
      console.error('[AnalysisSummary] stock_master fetch error:', stockMasterError);
    }
    if (mfError) {
      console.error('[AnalysisSummary] mf_transactions fetch error:', mfError);
    }
    if (fundMasterError) {
      console.error('[AnalysisSummary] fund_master fetch error:', fundMasterError);
    }

    const cmpMap = new Map((stockMaster || []).map((m) => [m.stock_name, toNumber(m.cmp)]));
    const lcpMap = new Map((stockMaster || []).map((m) => [m.stock_name, toNumber(m.lcp)]));
    const stockMasterMap = new Map((stockMaster || []).map((row) => [String(row.stock_name || '').trim(), row]));
    const fundPriceMap = new Map((fundMaster || []).map((m) => [m.fund_short_name, { cmp: toNumber(m.cmp), lcp: toNumber(m.lcp) }]));
    const fundMasterMap = new Map((fundMaster || []).map((row) => [String(row.fund_short_name || '').trim(), row]));

    if (!stockTxns?.length) {
      console.warn('[AnalysisSummary] No stock_transactions returned. First few rows:', stockTxns?.slice?.(0, 3));
    }
    if (!stockMaster?.length) {
      console.warn('[AnalysisSummary] No stock_master rows returned.');
    }
    if (!mfTxns?.length) {
      console.warn('[AnalysisSummary] No mf_transactions returned. First few rows:', mfTxns?.slice?.(0, 3));
    }
    if (!fundMaster?.length) {
      console.warn('[AnalysisSummary] No fund_master rows returned.');
    }

    // Process Equity Transactions (no FIFO: use raw open lots)
    const equityActive = [];
    const openStockTxns = (stockTxns || []).filter((txn) => !txn.sell_date);

    openStockTxns.forEach((txn) => {
      const stockName = String(txn.stock_name || '').trim();
      if (!stockName) {
        console.warn('[AnalysisSummary] Encountered stock transaction without stock_name:', txn);
        return;
      }

      const quantity = toNumber(txn.quantity);
      const price = toNumber(txn.buy_price);
      const accountName = txn.account_name || 'Unknown';
      const accountType = txn.account_type || 'STOCK';
      const masterInfo = stockMasterMap.get(stockName) || {};
      const cmp = cmpMap.get(stockName) || 0;
      const lcp = lcpMap.get(stockName) || 0;
      const investedAmount = quantity * price;
      const marketValue = quantity * cmp;
      const unrealizedGain = marketValue - investedAmount;
      const unrealizedGainPercent = investedAmount > 0 ? (unrealizedGain / investedAmount) * 100 : 0;
      const dayChange = quantity * (cmp - lcp);

      const flows = [];
      if (investedAmount > 0) {
        flows.push({ amount: -investedAmount, date: txn.buy_date });
      }
      if (marketValue > 0) {
        flows.push({ amount: marketValue, date: new Date().toISOString() });
      }

      equityActive.push({
        stock_name: stockName,
        account_name: accountName,
        account_type: accountType,
        sector: masterInfo.sector || 'Unknown',
        category: masterInfo.category || 'Unknown',
        invested_amount: investedAmount,
        market_value: marketValue,
        unrealized_gain: unrealizedGain,
        unrealized_gain_percent: unrealizedGainPercent,
        day_change: dayChange,
        units: quantity,
        cmp,
        master_cmp: cmp,
        master_lcp: lcp,
        buy_date: txn.buy_date,
        buy_price: price,
        cashflows: flows,
        xirr: calculateXirr(flows),
      });
    });

    const equityClosed = [];
    const closedStockTxns = (stockTxns || []).filter((txn) => txn.sell_date);

    closedStockTxns.forEach((txn) => {
      const stockName = String(txn.stock_name || '').trim();
      if (!stockName) {
        return;
      }

      const quantity = toNumber(txn.quantity ?? txn.units);
      const units = Math.abs(quantity);
      const buyPrice = toNumber(txn.buy_price);
      const sellPrice = toNumber(txn.sell_price);
      const investedAmount = units * buyPrice;
      const saleAmount = units * sellPrice;
      const chargesAllocated = 0; // No charges field in database
      const netSaleValue = saleAmount - chargesAllocated;
      const gain = netSaleValue - investedAmount;
      const gainPercent = investedAmount > 0 ? (gain / investedAmount) * 100 : 0;
      const accountName = txn.account_name || 'Unknown';
      const accountType = txn.account_type || 'STOCK';
      const masterInfo = stockMasterMap.get(stockName) || {};
      const buyDate = normalizeDate(txn.buy_date);
      const sellDate = normalizeDate(txn.sell_date);

      const flows = [];
      if (investedAmount !== 0 && buyDate) {
        flows.push({ amount: -investedAmount, date: buyDate });
      }
      if (netSaleValue !== 0 && sellDate) {
        flows.push({ amount: netSaleValue, date: sellDate });
      }

      equityClosed.push({
        stock_name: stockName,
        account_name: accountName,
        account_type: accountType,
        sector: masterInfo.sector || 'Unknown',
        category: masterInfo.category || 'Unknown',
        invested_amount: investedAmount,
        sale_amount: saleAmount,
        charges_allocated: chargesAllocated,
        net_sale_value: netSaleValue,
        gain,
        gain_percent: gainPercent,
        units,
        buy_date: buyDate,
        sell_date: sellDate,
        buy_price: buyPrice,
        sell_price: sellPrice,
        cashflows: flows,
        xirr: calculateXirr(flows),
      });
    });


   // Process Mutual Fund Transactions (FIFO logic for active vs closed lots)
const mfActive = []; // open lots per fund
const mfClosed = []; // closed lots per fund

const groupByFund = new Map();
(mfTxns || []).forEach((txn) => {
  const fundName = String(txn.fund_short_name || '').trim();
  if (!fundName) {
    return;
  }
  if (!groupByFund.has(fundName)) {
    groupByFund.set(fundName, []);
  }
  groupByFund.get(fundName).push(txn);
});

groupByFund.forEach((txns, fundName) => {
  const lotsByAccount = new Map();
  txns.forEach((txn) => {
    const accountName = String(txn.account_name || '').trim();
    if (!lotsByAccount.has(accountName)) {
      lotsByAccount.set(accountName, []);
    }
    lotsByAccount.get(accountName).push(txn);
  });

  const openLots = [];
  const closedLots = [];
  const fundInfo = fundMasterMap.get(fundName) || {};
  const { cmp = 0, lcp = 0, category = 'Unknown', amc_name: amcName = 'Unknown' } = fundInfo;

  lotsByAccount.forEach((accountTxns, accountName) => {
    const sorted = accountTxns
      .slice()
      .map((txn, index) => {
        const fundNameFormatted = String(txn.fund_short_name || '').trim();
        const accountNameFormatted = String(txn.account_name || '').trim();
        const type = String(txn.transaction_type || '').toLowerCase();
        const units = toNumber(txn.units);
        const nav = toNumber(txn.nav);
        const effectiveDate =
          parseMfTransactionDate(txn.date) || parseMfTransactionDate(txn.txn_date) || parseMfTransactionDate(txn.created_at) || null;

        return {
          ...txn,
          fundName: fundNameFormatted,
          accountName: accountNameFormatted,
          type,
          units,
          nav,
          effectiveDate,
          __sequence: index,
          __effectiveDate: effectiveDate,
        };
      })
      .filter((txn) => txn && Number.isFinite(txn.units) && Math.abs(txn.units) > 1e-8)
      .sort((a, b) => {
        const aDate = a.__effectiveDate ? a.__effectiveDate.getTime() : Number.POSITIVE_INFINITY;
        const bDate = b.__effectiveDate ? b.__effectiveDate.getTime() : Number.POSITIVE_INFINITY;
        if (aDate !== bDate) return aDate - bDate;
        return a.__sequence - b.__sequence;
      });

    sorted.forEach((txn) => {
      const { units, nav, type, effectiveDate } = txn;

      if (!Number.isFinite(units) || !Number.isFinite(nav) || Math.abs(units) <= 1e-8 || nav <= 0) {
        return;
      }

      if (type === 'buy' && units > 0) {
        openLots.push({
          units,
          cost: units * nav,
          nav,
          date: effectiveDate,
          order: effectiveDate ? effectiveDate.getTime() : Number.POSITIVE_INFINITY,
          sequence: txn.__sequence,
        });
        return;
      }

      if (type === 'sell') {
        const unitsToConsume = Math.abs(units);
        if (unitsToConsume <= 1e-8) {
          return;
        }

        const { consumed, remaining } = consumeLots(openLots, unitsToConsume);

        if (!consumed.length) {
          return;
        }

        if (remaining > 1e-6) {
          console.warn('[AnalysisSummary] MF sale consumed more units than available', {
            fundName,
            accountName,
            remaining,
            transaction: txn,
          });
        }

        let totalInvested = 0;
        const saleCashflows = [];

        consumed.forEach((portion) => {
          const { cost, buyDate } = portion;
          totalInvested += cost;

          if (cost > 0 && buyDate) {
            saleCashflows.push({ amount: -cost, date: buyDate });
          }
        });

        const totalUnitsSold = consumed.reduce((sum, portion) => sum + portion.units, 0);
        const saleAmount = nav * totalUnitsSold;
        if (saleAmount > 0) {
          const saleDate = effectiveDate ? effectiveDate.toISOString() : normalizeDate(txn.date) || new Date().toISOString();
          saleCashflows.push({ amount: saleAmount, date: saleDate });
          const gain = saleAmount - totalInvested;
          const gainPercent = totalInvested > 0 ? (gain / totalInvested) * 100 : 0;

          closedLots.push({
            invested_amount: totalInvested,
            sale_amount: saleAmount,
            gain,
            gain_percent: gainPercent,
            units: totalUnitsSold,
            cashflows: saleCashflows,
          });
        }
      }
    });
  });

  // Aggregate open lots for active (only if no closed lots)
  const openLotsFiltered = openLots.filter((lot) => lot.units > 1e-8);
  if (openLotsFiltered.length && closedLots.length === 0) {
    const valuationPrice = cmp > 0 ? cmp : lcp > 0 ? lcp : 0;
    const totalUnits = openLotsFiltered.reduce((sum, lot) => sum + lot.units, 0);
    const totalCost = openLotsFiltered.reduce((sum, lot) => sum + Math.max(lot.cost, 0), 0);

    if (totalUnits >= 1) {
      const marketValue = totalUnits * valuationPrice;
      const gain = marketValue - totalCost;
      const gainPercent = totalCost > 1e-8 ? (gain / totalCost) * 100 : 0;

      mfActive.push({
        fund_short_name: fundName,
        category,
        amc_name: amcName,
        units: totalUnits,
        invested: totalCost,
        marketValue,
        cmp: valuationPrice,
        avgBuy: totalUnits > 0 ? totalCost / totalUnits : 0,
        urp: gain,
        urpPct: gainPercent,
      });
    }
  }

  // Aggregate closed lots for closed
  if (closedLots.length) {
    const totalInvested = closedLots.reduce((sum, lot) => sum + lot.invested_amount, 0);
    const totalClosedValue = closedLots.reduce((sum, lot) => sum + lot.sale_amount, 0);
    const totalGain = closedLots.reduce((sum, lot) => sum + lot.gain, 0);
    const totalUnits = closedLots.reduce((sum, lot) => sum + lot.units, 0);

    mfClosed.push({
      fund_short_name: fundName,
      category,
      amc_name: amcName,
      invested: totalInvested,
      closedValue: totalClosedValue,
      urp: totalGain,
      urpPct: totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0,
      units: totalUnits,
    });
  }
});

    return {
      equityActive,
      equityClosed,
      mfActive,
      mfClosed,
    };
  } catch (error) {
    console.error('Analysis Summary error:', error);
    throw error;
  }
}

export async function getTopMutualFunds(sortBy = 'absReturnPct', sortDirection = 'desc') {
  try {
    const [{ data: transactions, error: txnError }, { data: masters, error: masterError }] = await Promise.all([
      fetchAllRows(supabase, 'mf_transactions', {
        select: 'fund_short_name, account_name, transaction_type, date, units, nav',
        chunkSize: 1000,
      }),
      fetchAllRows(supabase, 'fund_master', {
        select: 'fund_short_name, cmp, lcp',
      }),
    ]);

    if (txnError) throw new Error(txnError.message || 'Failed to load MF transactions');
    if (masterError) throw new Error(masterError.message || 'Failed to load fund master');

    const cmpMap = new Map(
      (masters || []).map((row) => [String(row.fund_short_name).trim(), { cmp: toNumber(row.cmp), lcp: toNumber(row.lcp) }]),
    );
    const fundData = new Map();

    (transactions || []).forEach((txn) => {
      const fundName = String(txn.fund_short_name || '').trim();
      if (!fundName) return;
      if (!fundData.has(fundName)) {
        fundData.set(fundName, []);
      }
      fundData.get(fundName).push(txn);
    });

    const funds = [];

    fundData.forEach((txns, fundName) => {
      const fifo = [];
      const cashflows = [];
      const transactionTypes = new Set();



      txns
        .slice()
        .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
        .forEach((txn) => {
          const rawType = String(txn.transaction_type || '').trim();
          const unitsRaw = toNumber(txn.units);
          const normalizedType = normalizeMfTransactionType(rawType, unitsRaw);
          const type = (normalizedType || rawType || '').toLowerCase();
          transactionTypes.add(type);

          const units = Math.abs(unitsRaw);
          const nav = toNumber(txn.nav);
          const date = txn.date || new Date().toISOString();

          if (!units || !Number.isFinite(nav)) {
            return;
          }

          if (type === 'buy' || (type === '' && unitsRaw > 0)) {
            fifo.push({ units, nav, date });
            cashflows.push({ amount: -units * nav, date });
          } else if (type === 'sell' || (type === '' && unitsRaw < 0)) {
            let remaining = units;
            let realized = 0;

            while (remaining > 0 && fifo.length) {
              const lot = fifo[0];
              const consumed = Math.min(remaining, lot.units);
              realized += consumed * nav;
              lot.units -= consumed;
              remaining -= consumed;
              if (lot.units <= 1e-8) fifo.shift();
            }

            if (realized > 0) {
              cashflows.push({ amount: realized, date });
            }
          } else if (type === 'charges') {
            const amount = units * nav;
            if (amount > 0) {
              cashflows.push({ amount: -amount, date });
            }
          }
        });

      let invested = 0;
      let marketValue = 0;
      let totalUnits = 0;
      const cmpInfo = cmpMap.get(fundName) || { cmp: 0, lcp: 0 };
      const priceToUse = cmpInfo.cmp > 0 ? cmpInfo.cmp : cmpInfo.lcp;

      fifo.forEach((lot) => {
        invested += lot.units * lot.nav;
        const navToUse = priceToUse > 0 ? priceToUse : lot.nav;
        marketValue += lot.units * navToUse;
        totalUnits += lot.units;
      });

      if (totalUnits > 0) {
        if (marketValue > 0) {
          cashflows.push({ amount: marketValue, date: new Date().toISOString() });
        }

        const absReturn = marketValue - invested;
        const absReturnPct = invested > 0 ? (absReturn / invested) * 100 : 0;
        const xirr = calculateXirr(cashflows);

        funds.push({
          name: fundName,
          invested,
          marketValue,
          absReturn,
          absReturnPct,
          xirr,
          totalUnits,
        });
      }
    });

    // Sort by specified criteria and take top 5
    const toComparableValue = (fund) => {
      const value = fund[sortBy];
      return typeof value === 'number' && isFinite(value) ? value : 0;
    };
    funds.sort((a, b) => {
      const aVal = toComparableValue(a);
      const bVal = toComparableValue(b);
      return sortDirection === 'desc' ? bVal - aVal : aVal - bVal;
    });
    const topFunds = funds.slice(0, 5);



    return topFunds;
  } catch (error) {
    console.error('Top Mutual Funds error:', error);
    throw error;
  }
}

const normalizeAccountTypeForFreeStocks = (accountType, accountName) => {
  const normalizedType = (accountType ?? '').toString().trim().toUpperCase();
  const normalizedName = (accountName ?? '').toString().trim().toUpperCase();

  if (normalizedType.includes('FREE') || normalizedName.includes('FREE')) {
    return 'FREE';
  }

  if (normalizedType.includes('REGULAR')) {
    return 'REGULAR';
  }

  return normalizedType || 'REGULAR';
};

export async function getAnalysisFreeStocks() {
  try {
    let [{ data: stockTxns }, { data: stockMaster }] = await Promise.all([
      fetchAllRows(supabase, 'stock_transactions', {
        select: 'stock_name, quantity, buy_price, sell_date, account_name, account_type, buy_date',
      }),
      fetchAllRows(supabase, 'stock_master', {
        select: 'stock_name, cmp',
      }),
    ]);

    // Re-fetch with pagination if needed
    try {
      const headRes = await supabase.from('stock_transactions').select('stock_name', { count: 'exact', head: true });
      const totalCount = headRes.count || 0;
      const fetchedCount = (stockTxns || []).length;
      if (totalCount > fetchedCount) {
        const pageSize = 1000;
        const all = [];
        for (let from = 0; from < totalCount; from += pageSize) {
          const to = Math.min(from + pageSize - 1, totalCount - 1);
          const page = await supabase
            .from('stock_transactions')
            .select('stock_name, quantity, buy_price, sell_date, account_name, account_type, buy_date')
            .range(from, to);
          all.push(...(page.data || []));
        }
        stockTxns = all;
      }
    } catch (countErr) {
      console.warn('[AnalysisFreeStocks] count check failed:', countErr);
    }

    const cmpMap = new Map((stockMaster || []).map((m) => [m.stock_name, toNumber(m.cmp)]));
    const freeStocks = [];
    const regularStocks = [];

    // Group by stock name, considering only unsold positions
    const byStock = new Map();
    (stockTxns || []).forEach((txn) => {
      const name = String(txn.stock_name || '').trim();
      if (!name) return;
      if (!byStock.has(name)) byStock.set(name, []);
      byStock.get(name).push(txn);
    });

    byStock.forEach((txns, stockName) => {
      const openTxns = txns.filter(txn => !txn.sell_date);
      if (openTxns.length === 0) return;

      let totalFreeUnits = 0;
      let totalFreeInvested = 0;
      let totalFreeMV = 0;
      let totalRegularUnits = 0;
      let totalRegularInvested = 0;
      let totalRegularMV = 0;
      const cmp = cmpMap.get(stockName) || 0;

      // Prepare XIRR cashflows including current market value
      const getXirrFlows = (txns) => {
        const flows = txns.map(txn => ({
          date: txn.buy_date,
          amount: -1 * (txn.quantity * txn.buy_price) // Negative for purchases
        }));
        
        // Add current market value as positive cashflow
        const totalUnits = txns.reduce((sum, txn) => sum + toNumber(txn.quantity), 0);
        if (totalUnits > 0) {
          flows.push({
            date: new Date().toISOString().split('T')[0], // Today's date
            amount: totalUnits * cmp // Positive for current value
          });
        }
        
        return calculateXirr(flows);
      };

      const transactions = openTxns.map((txn, index) => {
        const quantity = toNumber(txn.quantity);
        const buyPrice = toNumber(txn.buy_price);
        const accountName = (txn.account_name || '').trim();
        const accountType = normalizeAccountTypeForFreeStocks(txn.account_type, accountName);

        // Calculate individual transaction XIRR
        const xirrValue = getXirrFlows([{
          ...txn,
          quantity,
          buy_price: buyPrice
        }]);

        return {
          id: index + 1,
          stock_name: txn.stock_name,
          buy_date: txn.buy_date,
          buy_price: buyPrice,
          quantity,
          amount: quantity * buyPrice,
          account_name: accountName,
          account_type: accountType,
          lotKey: `${accountType}::${txn.stock_name}::${accountName || 'Unknown'}`,
          xirr: xirrValue // Add XIRR to transaction object
        };
      });

      // Calculate totals from transactions and group XIRR
      const freeTransactions = transactions.filter(t => t.account_type === 'FREE');
      const regularTransactions = transactions.filter(t => t.account_type !== 'FREE');

      transactions.forEach((txn) => {
        const invested = txn.quantity * txn.buy_price;
        const mv = txn.quantity * cmp;

        if (txn.account_type === 'FREE') {
          totalFreeUnits += txn.quantity;
          totalFreeInvested += invested;
          totalFreeMV += mv;
        } else {
          totalRegularUnits += txn.quantity;
          totalRegularInvested += invested;
          totalRegularMV += mv;
        }
      });

      // Add to appropriate list if there are open positions
      if (totalFreeUnits > 0) {
        freeStocks.push({
          stockName,
          accountName: 'Multiple',
          invested: totalFreeInvested,
          marketValue: totalFreeMV,
          profit: totalFreeMV - totalFreeInvested,
          profitPercent: totalFreeInvested > 0 ? ((totalFreeMV - totalFreeInvested) / totalFreeInvested) * 100 : 0,
          quantity: totalFreeUnits,
          avgPrice: totalFreeUnits > 0 ? totalFreeInvested / totalFreeUnits : 0,
          accountType: 'FREE',
          xirr: getXirrFlows(freeTransactions), // Add group XIRR
          transactions: freeTransactions
        });
      }

      if (totalRegularUnits > 0) {
        regularStocks.push({
          stockName,
          accountName: 'Multiple',
          invested: totalRegularInvested,
          marketValue: totalRegularMV,
          profit: totalRegularMV - totalRegularInvested,
          profitPercent: totalRegularInvested > 0 ? ((totalRegularMV - totalRegularInvested) / totalRegularInvested) * 100 : 0,
          quantity: totalRegularUnits,
          avgPrice: totalRegularUnits > 0 ? totalRegularInvested / totalRegularUnits : 0,
          accountType: 'REGULAR',
          xirr: getXirrFlows(regularTransactions), // Add group XIRR
          transactions: regularTransactions
        });
      }
    });

    return { freeStocks, regularStocks };
  } catch (error) {
    console.error('Analysis Free Stocks error:', error);
    throw error;
  }
}