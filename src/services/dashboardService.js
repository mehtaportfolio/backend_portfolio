/**
 * Dashboard Service
 * Orchestrates data aggregation from all sources
 * Computes portfolio summary and asset allocation
 */

import { calculateStockLots, calculateMFLots } from './lotCalculator.js';
import {
  calculateBankHoldings,
  calculatePPFHoldings,
  calculateEPFHoldings,
  calculateNPSHoldings,
  calculateFDHoldings,
} from './aggregationService.js';
import { fetchUserAllData, fetchAllRows } from '../db/queries.js';

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseDate = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Try DD/MM/YYYY format
  const ddmmyyyyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyyMatch) {
    const [, d, m, y] = ddmmyyyyMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Try MM/DD/YYYY format
  const mmddyyyyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyyMatch) {
    const [, m, d, y] = mmddyyyyMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Try YYYY/MM/DD or YYYY-MM-DD
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const directDate = new Date(normalized);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  // Try adding time if no T
  if (!raw.includes("T")) {
    const withTime = new Date(raw + "T00:00:00");
    if (!Number.isNaN(withTime.getTime())) return withTime;
  }

  // Try as epoch
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const epochDate = new Date(numeric);
    if (!Number.isNaN(epochDate.getTime())) {
      return epochDate;
    }
  }
  return null;
};

/**
 * Build CMPs, LCPs, and Symbol maps from master tables
 */
export function buildCMPMaps(data, priceSource = 'stock_master') {
  const stockCmpMap = new Map();
  const stockLcpMap = new Map();
  const stockSymbolMap = new Map();
  const fundCmpMap = new Map();
  const fundLcpMap = new Map();
  const npsCmpMap = new Map();
  const npsLcpMap = new Map();

  // Use stock_mapping if available (Angel One), otherwise fall back to stock_master
  const stockData = data.stock_mapping?.data || data.stock_master?.data || [];

  (stockData).forEach((m) => {
    const name = String(m.stock_name || '').trim().toUpperCase();
    if (name) {
      stockCmpMap.set(name, toNumber(m.cmp));
      stockLcpMap.set(name, toNumber(m.lcp));
      if (m.symbol_ao) {
        stockSymbolMap.set(name, m.symbol_ao);
      }
    }
  });

  // Always populate from fund_master first as a baseline
  (data.fund_master?.data || []).forEach((m) => {
    const name = String(m.fund_short_name || '').trim().toUpperCase();
    if (name) {
      fundCmpMap.set(name, toNumber(m.cmp));
      fundLcpMap.set(name, toNumber(m.lcp));
    }
  });

  // Override with fund_master_backend if priceSource is not stock_master
  if (priceSource !== 'stock_master' && data.fund_master_backend?.data) {
    // Group by fund_short_name to get latest and previous NAV
    const groupedMF = new Map();
    (data.fund_master_backend.data).forEach((m) => {
      const name = String(m.fund_short_name || '').trim().toUpperCase();
      if (name) {
        if (!groupedMF.has(name)) {
          groupedMF.set(name, []);
        }
        groupedMF.get(name).push(m);
      }
    });

    groupedMF.forEach((history, name) => {
      // Data is already ordered by last_sync_at desc from query
      if (history.length > 0) {
        fundCmpMap.set(name, toNumber(history[0].nav));
        if (history.length > 1) {
          fundLcpMap.set(name, toNumber(history[1].nav));
        } else {
          // Fallback to cmp if only one record exists
          fundLcpMap.set(name, toNumber(history[0].nav));
        }
      }
    });
  }

  (data.nps_pension_fund_master?.data || []).forEach((m) => {
    const name = String(m.scheme_name || '').trim().toUpperCase();
    if (name) {
      npsCmpMap.set(name, toNumber(m.cmp));
      npsLcpMap.set(name, toNumber(m.lcp));
    }
  });

  return { stockCmpMap, stockLcpMap, stockSymbolMap, fundCmpMap, fundLcpMap, npsCmpMap, npsLcpMap };
}

/**
 * Compute dashboard asset allocation
 * @param {SupabaseClient} supabase - Supabase client
 * @param {string} priceSource - Price source ('stock_master' or 'stock_mapping')
 * @returns {Promise<object>} - Asset allocation data
 */
export async function getDashboardAssetAllocation(supabase, priceSource = 'stock_master') {
  console.log(`[DashboardService] getDashboardAssetAllocation called, priceSource: ${priceSource}`);

  try {
    // Fetch all user data in parallel
    const data = await fetchUserAllData(supabase, priceSource);
    
    console.log(`[DashboardService] fetchUserAllData returned data for tables: ${Object.keys(data).join(', ')}`);
    Object.keys(data).forEach(table => {
      console.log(`[DashboardService] Table ${table} has ${data[table]?.data?.length || 0} rows`);
    });

    // Check for errors
    const hasErrors = Object.values(data).some((result) => result.error);
    if (hasErrors) {
      console.warn('[Dashboard] Some data sources had errors, proceeding with available data');
    }

    // Build CMP and LCP maps
    const { stockCmpMap, stockLcpMap, stockSymbolMap, fundCmpMap, fundLcpMap, npsCmpMap, npsLcpMap } = buildCMPMaps(data, priceSource);

    // Calculate total equity charges
    const totalEquityCharges = (data.equity_charges?.data || []).reduce((sum, charge) => {
      return sum + toNumber(charge.other_charges) + toNumber(charge.dp_charges);
    }, 0);

    // Calculate all asset types
    const stockData = calculateStockLots(data.stock_transactions?.data, stockCmpMap, stockSymbolMap);
    const mfData = calculateMFLots(data.mf_transactions?.data, fundCmpMap);
    const bankData = calculateBankHoldings(data.bank_transactions?.data);
    
    // Calculate dayChange for stocks and ETFs
    let stockDayChange = 0;
    let etfDayChange = 0;
    if (stockData.holdings) {
      stockData.holdings.forEach((holding) => {
        const name = String(holding.stockName || '').trim().toUpperCase();
        const lcp = stockLcpMap.get(name) || 0;
        const dayChange = lcp > 0 ? holding.quantity * (holding.cmp - lcp) : 0;
        
        const isETF = (holding.equityType || '').toLowerCase() === 'etf' || 
                      holding.accountType === 'ETF' || 
                      ['ETF', 'BEES', 'NIFTYBEES', 'JUNIORBEES', 'BANKBEES', 'GOLDBEES'].some(p => name.includes(p));
        
        const isStock = !isETF && ((holding.equityType || '').toLowerCase() === 'stocks' || ['free', 'regular', 'esop'].includes((holding.accountType || '').toLowerCase()));
        
        if (isETF) {
          etfDayChange += dayChange;
        } else if (isStock) {
          stockDayChange += dayChange;
        }
      });
    }
    // Calculate dayChange for MF
    let mfDayChange = 0;
    if (mfData.holdings) {
      mfData.holdings.forEach((holding) => {
        const name = String(holding.fundName || '').trim().toUpperCase();
        const lcp = fundLcpMap.get(name) || 0;
        const dayChange = lcp > 0 ? holding.units * (holding.cmp - lcp) : 0;
        mfDayChange += dayChange;
      });
    }
    
    const ppfTransactions = (data.ppf_transactions?.data || []).filter(
      (txn) => String(txn.account_type || '').toLowerCase() === 'ppf'
    );
    const fdTransactions = (data.ppf_transactions?.data || []).filter(
      (txn) => String(txn.account_type || '').toLowerCase() === 'fd'
    );

    const ppfData = calculatePPFHoldings(ppfTransactions);
    const fdData = calculateFDHoldings(fdTransactions);

    const epfData = calculateEPFHoldings(data.epf_transactions?.data);
    const npsData = calculateNPSHoldings(data.nps_transactions?.data, npsCmpMap);
    
    // Calculate dayChange for NPS
    let npsDayChange = 0;
    if (npsData.holdings) {
      npsData.holdings.forEach((holding) => {
        const name = String(holding.schemeName || '').trim().toUpperCase();
        const lcp = npsLcpMap.get(name) || 0;
        const dayChange = lcp > 0 ? holding.units * (holding.cmp - lcp) : 0;
        npsDayChange += dayChange;
      });
    }
    // Calculate total invested value
    let totalInvestedValue = stockData.stock.invested + stockData.etf.invested + mfData.invested + bankData.total + (ppfData.invested || 0) + epfData.invested + npsData.invested + fdData.invested;

    // Build asset rows
    const rows = [
      {
        assetType: 'Stock',
        marketValue: stockData.stock.marketValue,
        investedValue: stockData.stock.invested,
        simpleProfit: stockData.stock.marketValue - stockData.stock.invested,
        dayChange: stockDayChange,
      },
      {
        assetType: 'ETF',
        marketValue: stockData.etf.marketValue,
        investedValue: stockData.etf.invested,
        simpleProfit: stockData.etf.marketValue - stockData.etf.invested,
        dayChange: etfDayChange,
      },
      {
        assetType: 'MF',
        marketValue: mfData.marketValue,
        investedValue: mfData.invested,
        simpleProfit: mfData.marketValue - mfData.invested,
        dayChange: mfDayChange,
      },
      {
        assetType: 'Bank',
        marketValue: bankData.total,
        investedValue: bankData.total,
        simpleProfit: 0,
        dayChange: 0,
      },
      {
        assetType: 'PPF',
        marketValue: ppfData.marketValue ?? ppfData.total,
        investedValue: ppfData.invested,
        simpleProfit: (ppfData.marketValue ?? ppfData.total) - ppfData.invested,
        dayChange: 0,
      },
      {
        assetType: 'EPF',
        marketValue: epfData.total,
        investedValue: epfData.invested,
        simpleProfit: epfData.interest,
        dayChange: 0,
      },
      {
        assetType: 'NPS',
        marketValue: npsData.marketValue,
        investedValue: npsData.invested,
        simpleProfit: npsData.marketValue - npsData.invested,
        dayChange: npsDayChange,
      },
      {
        assetType: 'FD',
        marketValue: fdData.marketValue,
        investedValue: fdData.invested,
        simpleProfit: fdData.marketValue - fdData.invested,
        dayChange: 0,
      },
    ];

    // Calculate total market value
    const totalMarketValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
    const totalProfit = totalMarketValue - totalInvestedValue;

    // Add allocation percentages
    const enrichedRows = rows.map((row) => ({
      ...row,
      marketAllocation: totalMarketValue > 0 ? (row.marketValue / totalMarketValue) * 100 : 0,
      investedAllocation: totalInvestedValue > 0 ? (row.investedValue / totalInvestedValue) * 100 : 0,
      simpleProfitPercent:
        row.investedValue > 1e-8 ? (row.simpleProfit / row.investedValue) * 100 : 0,
    }));

    // Note: Allocations are based on pre-charge invested values for individual assets

    const summary = {
      totalMarketValue,
      totalInvestedValue,
      totalProfit,
      profitPercent: totalInvestedValue > 1e-8 ? (totalProfit / totalInvestedValue) * 100 : 0,
    };

    const overallDayChange = stockDayChange + etfDayChange + mfDayChange + npsDayChange;

    return {
      rows: enrichedRows,
      summary: {
        ...summary,
        overallDayChange
      },
      stockHoldings: stockData.holdings,
      bankSavings: bankData.savings,
      bankDemat: bankData.demat,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[Dashboard] Error computing asset allocation:', error);
    throw error;
  }
}

/**
 * Get dashboard summary (quick overview)
 */
export async function getDashboardSummary(supabase, priceSource = 'stock_master') {
  const allocation = await getDashboardAssetAllocation(supabase, priceSource);
  return allocation.summary;
}

/**
 * Get live price details for dashboard
 * Returns stock transactions with mapping data for live price calculation
 */
export async function getLivePriceDetails(supabase) {
  console.log(`[DashboardService] getLivePriceDetails called (single-user mode)`);

  // Single-user mode: Get all account names from user_master
  const { data: userMaster, error: userError } = await fetchAllRows(supabase, 'user_master', {
    select: 'account_name'
  });

  if (userError) throw userError;

  const accountNames = userMaster?.map(u => u.account_name).filter(Boolean) || [];
  console.log(`[DashboardService] Found system accountNames:`, accountNames);

  if (accountNames.length === 0) {
    console.warn(`[DashboardService] No account names found in user_master`);
    return [];
  }

  // Get stock transactions for user's accounts
  const { data: transactions, error: txnError } = await fetchAllRows(supabase, 'stock_transactions', {
    select: 'stock_name, quantity, buy_price, sell_date, account_type, buy_date, account_name, equity_type',
    filters: [
      (q) => q.in('account_name', accountNames),
      (q) => q.is('sell_date', null)
    ]
  });

  if (txnError) throw txnError;

  if (!transactions || transactions.length === 0) {
    return [];
  }

  // Get stock mapping for symbol_ao and lcp
  const stockNames = [...new Set(transactions.map(t => String(t.stock_name || '').trim()))].filter(Boolean);

  const [mappingResponse, masterResponse] = await Promise.all([
    fetchAllRows(supabase, 'stock_mapping', {
      select: 'stock_name, symbol_ao, lcp',
      filters: [(q) => q.in('stock_name', stockNames)]
    }),
    fetchAllRows(supabase, 'stock_master', {
      select: 'stock_name, lcp',
      filters: [(q) => q.in('stock_name', stockNames)]
    })
  ]);

  if (mappingResponse.error) throw mappingResponse.error;
  if (masterResponse.error) throw masterResponse.error;

  const normalizeStockName = (name) => String(name || '').trim().toUpperCase();

  const mappingMap = new Map();
  (mappingResponse.data || []).forEach(m => {
    mappingMap.set(normalizeStockName(m.stock_name), { symbol_ao: m.symbol_ao, lcp: m.lcp });
  });

  const masterMap = new Map();
  (masterResponse.data || []).forEach(m => {
    const key = normalizeStockName(m.stock_name);
    if (!mappingMap.has(key)) {
      masterMap.set(key, { symbol_ao: null, lcp: m.lcp });
    }
  });

  // Combine transactions with mapping data and allow fallback to stock_master
  const result = transactions.map(txn => {
    const key = normalizeStockName(txn.stock_name);
    const mapping = mappingMap.get(key) || masterMap.get(key) || {};
    return {
      ...txn,
      symbol_ao: mapping.symbol_ao || null,
      lcp: mapping.lcp || 0
    };
  });

  const mappedTransactionCount = result.filter(r => r.symbol_ao).length;
  console.log(`[Dashboard] live-price-details mapped transactions: ${mappedTransactionCount} / ${result.length}`);

  return result;
}

/**
 * Get investment growth data (yearwise/assetwise)
 */
export async function getInvestmentGrowth(supabase, priceSource = 'stock_master') {
  console.log(`[DashboardService] getInvestmentGrowth called`);

  try {
    const data = await fetchUserAllData(supabase, priceSource);

    const yearBreakdowns = new Map();
    const allYearsSet = new Set();

    const getYearData = (year) => {
      if (!yearBreakdowns.has(year)) {
        yearBreakdowns.set(year, {
          combined: { invested: 0, marketValue: 0 },
          assets: new Map()
        });
      }
      return yearBreakdowns.get(year);
    };

    const addInvestment = (year, assetType, invested, marketValue = 0) => {
      if (!year || (invested === 0 && marketValue === 0)) return;
      allYearsSet.add(year);
      const yearData = getYearData(year);

      // Include Bank in combined totals as per user request to match old logic
      yearData.combined.invested += invested;
      yearData.combined.marketValue += marketValue;

      if (!yearData.assets.has(assetType)) {
        yearData.assets.set(assetType, { invested: 0, marketValue: 0 });
      }
      const assetData = yearData.assets.get(assetType);
      assetData.invested += invested;
      assetData.marketValue += marketValue;
    };

    const { stockCmpMap, fundCmpMap, npsCmpMap } = buildCMPMaps(data, priceSource);

    // 1. Stocks & ETFs (Cost of OPEN positions attributed to purchase year)
    (data.stock_transactions?.data || []).forEach(tx => {
      if (tx.sell_date != null) return; // ONLY open positions

      const buyDate = parseDate(tx.buy_date);
      if (buyDate) {
        const year = buyDate.getFullYear();
        const quantity = toNumber(tx.quantity);
        const buyPrice = toNumber(tx.buy_price);
        const invested = quantity * buyPrice;
        const name = String(tx.stock_name || '').trim().toUpperCase();
        
        const cmp = stockCmpMap.get(name) || 0;
        const marketValue = quantity * (cmp > 0 ? cmp : buyPrice);

        const isETF = (tx.equity_type || '').toLowerCase() === 'etf' || 
                      tx.account_type === 'ETF' || 
                      ['ETF', 'BEES', 'NIFTYBEES', 'JUNIORBEES', 'BANKBEES', 'GOLDBEES'].some(p => name.includes(p));
        const assetType = isETF ? "ETF" : "Stock";
        
        addInvestment(year, assetType, invested, marketValue);
      }
    });

    // 2. MF (Buy - Withdrawal using FIFO lots)
    const mfLots = calculateMFLots(data.mf_transactions?.data, fundCmpMap);
    if (mfLots.holdings) {
      mfLots.holdings.forEach(holding => {
        const fundName = String(holding.fundName || '').trim().toUpperCase();
        const cmp = fundCmpMap.get(fundName) || 0;
        if (holding.lots) {
          holding.lots.forEach(lot => {
            const date = parseDate(lot.date);
            if (date) {
              const year = date.getFullYear();
              const invested = lot.cost;
              const marketValue = lot.units * (cmp > 0 ? cmp : (lot.cost / Math.max(lot.units, 1e-8)));
              addInvestment(year, "MF", invested, marketValue);
            }
          });
        }
      });
    }

    // 3. NPS (Buy - Withdrawal using FIFO lots)
    const npsLots = calculateNPSHoldings(data.nps_transactions?.data, npsCmpMap);
    if (npsLots.holdings) {
      npsLots.holdings.forEach(holding => {
        const schemeName = String(holding.schemeName || '').trim().toUpperCase();
        const cmp = npsCmpMap.get(schemeName) || 0;
        if (holding.lots) {
          holding.lots.forEach(lot => {
            const date = parseDate(lot.date);
            if (date) {
              const year = date.getFullYear();
              const invested = lot.cost;
              const marketValue = lot.units * (cmp > 0 ? cmp : (lot.cost / Math.max(lot.units, 1e-8)));
              addInvestment(year, "NPS", invested, marketValue);
            }
          });
        }
      });
    }

    // 4. PPF & FD (Deposit - Withdrawal)
    (data.ppf_transactions?.data || []).forEach(tx => {
      const date = parseDate(tx.txn_date || tx.date);
      if (date) {
        const year = date.getFullYear();
        const assetType = String(tx.account_type || "PPF").toUpperCase();
        const type = String(tx.transaction_type || '').toLowerCase();
        const amount = toNumber(tx.amount);
        
        if (type.includes('deposit') || type.includes('credit') || type.includes('create') || type.includes('open') || type.includes('contribution')) {
          addInvestment(year, assetType, amount, 0);
        } else if (type.includes('withdraw') || type.includes('debit') || type.includes('maturity')) {
          // For withdrawals, we only reduce the invested amount, not interest
          // This is a simplification but aligns with "Net Investment"
          addInvestment(year, assetType, -amount, 0);
        }
      }
    });

    // 5. EPF (Contribution - Withdrawal)
    (data.epf_transactions?.data || []).forEach(tx => {
      const date = parseDate(tx.contribution_date);
      if (date) {
        const year = date.getFullYear();
        const type = String(tx.invest_type || '').toLowerCase();
        const amount = toNumber(tx.employee_share) + toNumber(tx.employer_share) + toNumber(tx.pension_share);
        
        if (type.includes('withdraw')) {
          addInvestment(year, "EPF", -amount, 0);
        } else if (!type.includes('interest')) {
          addInvestment(year, "EPF", amount, 0);
        }
      }
    });

    // 6. Bank (Savings & Demat) - Process as latest snapshot per account to match old logic
    const bankTxns = data.bank_transactions?.data || [];
    if (bankTxns.length > 0) {
      const groups = new Map();
      let latestMonthNumeric = -Infinity;

      bankTxns.forEach(tx => {
        const type = String(tx.account_type || '').toLowerCase();
        if (type !== 'savings' && type !== 'demat') return;

        const date = parseDate(tx.txn_date);
        if (!date) return;

        const monthNumeric = date.getFullYear() * 100 + (date.getMonth() + 1);
        if (monthNumeric > latestMonthNumeric) {
          latestMonthNumeric = monthNumeric;
        }

        const key = `${tx.account_name || ''}||${tx.bank_name || ''}||${tx.account_type || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...tx, monthNumeric, date });
      });

      if (latestMonthNumeric > 0) {
        let latestTotal = 0;
        groups.forEach(list => {
          const sorted = list.sort((a, b) => b.date - a.date);
          const match = sorted.find(tx => tx.monthNumeric === latestMonthNumeric);
          if (match) {
            latestTotal += toNumber(match.amount);
          }
        });

        if (latestTotal > 0) {
          const year = Math.floor(latestMonthNumeric / 100);
          addInvestment(year, "Bank", latestTotal, latestTotal);
        }
      }
    }

    const labels = [...allYearsSet].sort((a, b) => a - b);

    // Return as yearly deltas (non-cumulative), frontend will handle cumulative build if needed
    const formattedYearBreakdowns = {};
    labels.forEach(year => {
      const yearData = yearBreakdowns.get(year);
      const assetsObj = {};
      yearData.assets.forEach((assetVal, assetKey) => {
        assetsObj[assetKey] = assetVal;
      });

      formattedYearBreakdowns[year] = {
        combined: yearData.combined,
        assets: assetsObj
      };
    });

    return {
      success: true,
      data: {
        labels,
        yearBreakdowns: formattedYearBreakdowns
      }
    };
  } catch (error) {
    console.error('[DashboardService] Error in getInvestmentGrowth:', error);
    throw error;
  }
}

export default { getDashboardAssetAllocation, getDashboardSummary, getLivePriceDetails, getInvestmentGrowth };
