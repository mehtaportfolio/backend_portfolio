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
import { fetchUserAllData } from '../db/queries.js';

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Build CMPs and LCPs maps from master tables
 */
export function buildCMPMaps(data) {
  const stockCmpMap = new Map();
  const stockLcpMap = new Map();
  const fundCmpMap = new Map();
  const fundLcpMap = new Map();
  const npsCmpMap = new Map();
  const npsLcpMap = new Map();

  (data.stock_master?.data || []).forEach((m) => {
    stockCmpMap.set(String(m.stock_name).trim(), toNumber(m.cmp));
    stockLcpMap.set(String(m.stock_name).trim(), toNumber(m.lcp));
  });

  (data.fund_master?.data || []).forEach((m) => {
    fundCmpMap.set(String(m.fund_short_name).trim(), toNumber(m.cmp));
    fundLcpMap.set(String(m.fund_short_name).trim(), toNumber(m.lcp));
  });

  (data.nps_pension_fund_master?.data || []).forEach((m) => {
    npsCmpMap.set(String(m.scheme_name).trim(), toNumber(m.cmp));
    npsLcpMap.set(String(m.scheme_name).trim(), toNumber(m.lcp));
  });

  return { stockCmpMap, stockLcpMap, fundCmpMap, fundLcpMap, npsCmpMap, npsLcpMap };
}

/**
 * Compute dashboard asset allocation
 * @param {SupabaseClient} supabase - Supabase client
 * @param {string} userId - User ID
 * @returns {Promise<object>} - Asset allocation data
 */
export async function getDashboardAssetAllocation(supabase, userId) {

  try {
    // Fetch all user data in parallel
    const data = await fetchUserAllData(supabase, userId);

    // Check for errors
    const hasErrors = Object.values(data).some((result) => result.error);
    if (hasErrors) {
      console.warn('[Dashboard] Some data sources had errors, proceeding with available data');
    }

    // Build CMP and LCP maps
    const { stockCmpMap, stockLcpMap, fundCmpMap, fundLcpMap, npsCmpMap, npsLcpMap } = buildCMPMaps(data);

    // Calculate total equity charges
    const totalEquityCharges = (data.equity_charges?.data || []).reduce((sum, charge) => {
      return sum + toNumber(charge.other_charges) + toNumber(charge.dp_charges);
    }, 0);

    // Calculate all asset types
    const stockData = calculateStockLots(data.stock_transactions?.data, stockCmpMap);
    const mfData = calculateMFLots(data.mf_transactions?.data, fundCmpMap);
    const bankData = calculateBankHoldings(data.bank_transactions?.data);
    
    // Calculate dayChange for stocks and ETFs
    let stockDayChange = 0;
    let etfDayChange = 0;
    if (stockData.holdings) {
      stockData.holdings.forEach((holding) => {
        const lcp = stockLcpMap.get(holding.stockName) || 0;
        const dayChange = holding.quantity * (holding.cmp - lcp);
        
        const isETF = (holding.equityType || '').toLowerCase() === 'etf' || 
                      holding.accountType === 'ETF' || 
                      ['ETF', 'BEES', 'NIFTYBEES', 'JUNIORBEES', 'BANKBEES', 'GOLDBEES'].some(p => String(holding.stockName || '').toUpperCase().includes(p));
        
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
        const lcp = fundLcpMap.get(holding.fundName) || 0;
        const dayChange = holding.units * (holding.cmp - lcp);
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
        const lcp = npsLcpMap.get(holding.schemeName) || 0;
        const dayChange = holding.units * (holding.cmp - lcp);
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
export async function getDashboardSummary(supabase, userId) {
  const allocation = await getDashboardAssetAllocation(supabase, userId);
  return allocation.summary;
}

export default { getDashboardAssetAllocation, getDashboardSummary };