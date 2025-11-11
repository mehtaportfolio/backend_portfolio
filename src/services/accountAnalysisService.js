import { fetchUserAllData } from '../db/queries.js';
import { calculateStockLots, calculateMFLots } from './lotCalculator.js';
import { calculateNPSHoldings } from './aggregationService.js';
import { buildCMPMaps } from './dashboardService.js';

const toNumber = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatAccountName = (name) => {
  const trimmed = String(name ?? '').trim();
  return trimmed || 'Other Accounts';
};

const ASSET_LABELS = {
  stock: 'stocks',
  etf: 'etf',
  mf: 'mf',
  nps: 'nps',
};

const canonicalizeAssetType = (assetType = '') => {
  const normalized = String(assetType || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  switch (normalized) {
    case 'stock':
    case 'stocks':
    case 'equity':
      return 'stocks';
    case 'etf':
    case 'exchange_traded_fund':
      return 'etf';
    case 'mutual_fund':
    case 'mutualfund':
    case 'mf':
      return 'mf';
    case 'nps':
      return 'nps';
    default:
      return normalized || 'other';
  }
};

const normalizeHoldings = (holdings = []) => {
  return holdings.map((holding) => ({
    ...holding,
    invested: toNumber(holding.invested),
    marketValue: toNumber(holding.marketValue),
  }));
};

const sumByAccount = (accumulator, accountName, assetType, invested, marketValue) => {
  const normalizedAccount = formatAccountName(accountName);
  if (!accumulator.has(normalizedAccount)) {
    accumulator.set(normalizedAccount, {
      account_name: normalizedAccount,
      total_invested: 0,
      total_market_value: 0,
      breakdown: {},
    });
  }

  const accountTotals = accumulator.get(normalizedAccount);
  accountTotals.total_invested += invested;
  accountTotals.total_market_value += marketValue;

  const breakdownKey = canonicalizeAssetType(assetType);
  if (!accountTotals.breakdown[breakdownKey]) {
    accountTotals.breakdown[breakdownKey] = { invested: 0, marketValue: 0 };
  }

  accountTotals.breakdown[breakdownKey].invested += invested;
  accountTotals.breakdown[breakdownKey].marketValue += marketValue;
};

const attachProfitFields = (accounts = []) => {
  return accounts.map((account) => {
    const profit = account.total_market_value - account.total_invested;
    return {
      ...account,
      profit,
      profitPercent: account.total_invested > 1e-8 ? (profit / account.total_invested) * 100 : 0,
    };
  });
};

const buildAssetSummary = (accounts) => {
  const summary = {
    stock: { invested: 0, marketValue: 0 },
    etf: { invested: 0, marketValue: 0 },
    mf: { invested: 0, marketValue: 0 },
    nps: { invested: 0, marketValue: 0 },
  };

  accounts.forEach((account) => {
    Object.entries(account.breakdown).forEach(([assetType, values]) => {
      const key = canonicalizeAssetType(assetType);
      if (!summary[key]) return;
      summary[key].invested += values.invested;
      summary[key].marketValue += values.marketValue;
    });
  });

  return summary;
};

export async function getAccountAnalysis(supabase, userId) {
  if (!supabase) {
    throw new Error('Supabase client is required');
  }
  if (!userId) {
    throw new Error('User ID is required for account analysis');
  }

  const data = await fetchUserAllData(supabase, userId);

  const { stockCmpMap, fundCmpMap, npsCmpMap } = buildCMPMaps(data);

  const stockLots = calculateStockLots(data.stock_transactions?.data, stockCmpMap);
  const mfLots = calculateMFLots(data.mf_transactions?.data, fundCmpMap);
  const npsHoldings = calculateNPSHoldings(data.nps_transactions?.data, npsCmpMap);

  const accountsMap = new Map();

  // Stocks & ETFs (open lots only from calculateStockLots)
  normalizeHoldings(stockLots.holdings).forEach((holding) => {
    const isEtf = holding.accountType === 'ETF';
    const assetLabel = isEtf ? 'etf' : 'stocks';

    const accountName = isEtf ? holding.accountName || holding.accountType : holding.accountName;

    sumByAccount(
      accountsMap,
      accountName,
      assetLabel,
      holding.invested,
      holding.marketValue
    );
  });

  // Mutual Funds
  normalizeHoldings(mfLots.holdings).forEach((holding) => {
    sumByAccount(
      accountsMap,
      holding.accountName,
      ASSET_LABELS.mf,
      holding.invested,
      holding.marketValue
    );
  });

  // NPS (calculateNPSHoldings already deducts charges)
  (npsHoldings.holdings || []).forEach((holding) => {
    const invested = toNumber(holding.invested);
    const marketValue = toNumber(holding.marketValue);
    sumByAccount(
      accountsMap,
      holding.accountName,
      ASSET_LABELS.nps,
      invested,
      marketValue
    );
  });

  const accounts = attachProfitFields(Array.from(accountsMap.values()));
  accounts.sort((a, b) => b.total_market_value - a.total_market_value);

  const assetSummary = buildAssetSummary(accounts);

  const totals = {
    totalInvested: accounts.reduce((sum, account) => sum + account.total_invested, 0),
    totalMarketValue: accounts.reduce((sum, account) => sum + account.total_market_value, 0),
  };
  const totalProfit = totals.totalMarketValue - totals.totalInvested;

  const normalizeBreakdown = (rawBreakdown = {}) => {
    const normalized = {};
    Object.entries(rawBreakdown).forEach(([assetType, values]) => {
      const key = canonicalizeAssetType(assetType);
      normalized[key] = {
        invested: toNumber(values.invested),
        marketValue: toNumber(values.marketValue),
      };
    });
    return normalized;
  };

  const normalizedAccounts = accounts.map((account) => ({
    accountName: account.account_name,
    account_name: account.account_name,
    totalInvested: account.total_invested,
    total_invested: account.total_invested,
    totalMarketValue: account.total_market_value,
    total_market_value: account.total_market_value,
    profit: account.profit,
    profitPercent: account.profitPercent,
    breakdown: normalizeBreakdown(account.breakdown),
  }));

  const otherAccountsSource = accounts.find((account) => account.account_name === 'Other Accounts');
  const normalizedOtherAccounts = otherAccountsSource
    ? {
        totalInvested: otherAccountsSource.total_invested,
        total_invested: otherAccountsSource.total_invested,
        totalMarketValue: otherAccountsSource.total_market_value,
        total_market_value: otherAccountsSource.total_market_value,
        breakdown: normalizeBreakdown(otherAccountsSource.breakdown),
      }
    : { totalInvested: 0, total_invested: 0, totalMarketValue: 0, total_market_value: 0, breakdown: {} };

  return {
    accountWise: normalizedAccounts,
    accounts: normalizedAccounts,
    otherAccounts: normalizedOtherAccounts,
    assetSummary,
    totals: {
      invested: totals.totalInvested,
      marketValue: totals.totalMarketValue,
      profit: totalProfit,
      profitPercent: totals.totalInvested > 1e-8 ? (totalProfit / totals.totalInvested) * 100 : 0,
    },
    timestamp: new Date().toISOString(),
  };
}