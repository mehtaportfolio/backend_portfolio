/**
 * FIFO Lot Tracking & Calculation Service
 * Handles lot management for stocks, MF, and other securities
 */

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const FIFO_SALE_KEYWORDS = [
  'sell', 'redeem', 'withdraw', 'switch out', 'switch-out',
  'switch to', 'switch-to', 'stp out', 'stp-out', 'charges',
  'exit', 'migration', 'transfer', 'payout',
];

const parseTransactionDate = (value) => {
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

const reduceLotUnits = (lots, unitsToRemove) => {
  let remaining = unitsToRemove;
  lots.sort((a, b) => {
    const orderDiff = (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
    if (Math.abs(orderDiff) > 1e-8) {
      return orderDiff;
    }
    return (a.sequence ?? 0) - (b.sequence ?? 0);
  });
  while (remaining > 1e-8 && lots.length) {
    const currentLot = lots[0];
    const deduction = Math.min(remaining, currentLot.units);
    const costPerUnit = currentLot.units ? currentLot.cost / currentLot.units : 0;
    currentLot.units -= deduction;
    currentLot.cost -= deduction * costPerUnit;
    remaining -= deduction;
    if (currentLot.units <= 1e-8) {
      lots.shift();
    }
  }
};

/**
 * Calculate stock portfolio with FIFO lot tracking
 * @param {Array} transactions - Stock transactions
 * @param {Map} cmpMap - Current market prices (stock_name -> price)
 * @returns {object} - { stock, etf, holdings }
 */
export function calculateStockLots(transactions = [], cmpMap = new Map()) {
  const aggregated = new Map();
  let stockMarketValue = 0;
  let stockInvested = 0;
  let etfMarketValue = 0;
  let etfInvested = 0;
  const holdings = [];

  (transactions || []).forEach((txn) => {
    if (!txn.stock_name) return;
    if (txn.sell_date) return; // Only open positions

    const accountName = String(txn.account_name || '').trim();
    const accountType = String(txn.account_type || '').trim().toUpperCase();
    const stockName = String(txn.stock_name).trim();

    const key = `${accountName}||${accountType}||${stockName}`;
    const entry = aggregated.get(key) || {
      accountName,
      accountType,
      stockName,
      quantity: 0,
      invested: 0,
    };

    entry.quantity += toNumber(txn.quantity);
    entry.invested += toNumber(txn.quantity) * toNumber(txn.buy_price);
    aggregated.set(key, entry);
  });

  aggregated.forEach((entry) => {
    if (!entry.quantity) return;
    const cmp = cmpMap.get(entry.stockName) || 0;
    const marketValue = entry.quantity * cmp;
    const invested = entry.invested;
    const profit = marketValue - invested;
    const profitPercent = invested > 1e-8 ? (profit / invested) * 100 : 0;

    const holding = {
      stockName: entry.stockName,
      accountType: entry.accountType,
      accountName: String(entry.accountName || '').trim(),
      quantity: entry.quantity,
      invested: invested,
      marketValue: marketValue,
      profit: profit,
      profitPercent: profitPercent,
      cmp: cmp,
    };

    holdings.push(holding);

    if (entry.accountType === 'ETF') {
      etfMarketValue += marketValue;
      etfInvested += invested;
    } else {
      stockMarketValue += marketValue;
      stockInvested += invested;
    }
  });

  return {
    stock: { marketValue: stockMarketValue, invested: stockInvested },
    etf: { marketValue: etfMarketValue, invested: etfInvested },
    holdings,
  };
}

/**
 * Calculate MF portfolio with FIFO lot tracking
 * @param {Array} transactions - MF transactions
 * @param {Map} cmpMap - Fund CMPs (fund_name -> price)
 * @returns {object} - { marketValue, invested, holdings }
 */
export function calculateMFLots(transactions = [], cmpMap = new Map()) {
  const lotsByFund = new Map();
  let mfMarketValue = 0;
  let mfInvested = 0;
  const holdings = [];

  const mfTransactions = (transactions || [])
    .map((txn, index) => {
      const fundName = String(txn.fund_short_name || '').trim();
      if (!fundName) return null;
      const accountName = String(txn.account_name || '').trim();
      const type = String(txn.transaction_type || '').toLowerCase();
      const units = toNumber(txn.units);
      const nav = toNumber(txn.nav);
      const effectiveDate = parseTransactionDate(txn.date) || null;
      return {
        fundName,
        accountName,
        type,
        units,
        nav,
        effectiveDate,
        index,
      };
    })
    .filter((txn) => txn && Number.isFinite(txn.units) && Math.abs(txn.units) > 1e-8)
    .sort((a, b) => {
      const aTime = a.effectiveDate ? a.effectiveDate.getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.effectiveDate ? b.effectiveDate.getTime() : Number.POSITIVE_INFINITY;
      if (aTime !== bTime) return aTime - bTime;
      return a.index - b.index;
    });

  mfTransactions.forEach((txn) => {
    const { fundName, accountName, type, units, nav, effectiveDate, index } = txn;
    const fundKey = `${fundName}||${accountName}`;
    if (!lotsByFund.has(fundKey)) {
      lotsByFund.set(fundKey, []);
    }
    const lots = lotsByFund.get(fundKey);

    if (type.includes('buy') && units > 0) {
      lots.push({
        units,
        cost: units * nav,
        date: effectiveDate,
        order: effectiveDate ? effectiveDate.getTime() : Number.POSITIVE_INFINITY,
        sequence: index,
      });
      return;
    }

    const isSaleType = units < 0 || FIFO_SALE_KEYWORDS.some((keyword) => type.includes(keyword));

    if (isSaleType) {
      const unitsToRemove = units < 0 ? Math.abs(units) : units;
      reduceLotUnits(lots, unitsToRemove);
    }
  });

  lotsByFund.forEach((lots, key) => {
    const [fundNameRaw, accountName] = key.split('||');
    const fundName = fundNameRaw?.trim() || '';
    const openLots = lots.filter((lot) => lot.units > 1e-8);
    if (!openLots.length) return;

    const totalUnits = openLots.reduce((sum, lot) => sum + lot.units, 0);
    const totalCost = openLots.reduce((sum, lot) => sum + Math.max(lot.cost, 0), 0);
    const cmp = cmpMap.get(fundName) || 0;
    const marketValue = totalUnits * cmp;
    const profit = marketValue - totalCost;
    const profitPercent = totalCost > 1e-8 ? (profit / totalCost) * 100 : 0;

    holdings.push({
      fundName,
      accountName,
      units: totalUnits,
      invested: totalCost,
      marketValue,
      profit,
      profitPercent,
      cmp,
    });

    mfMarketValue += marketValue;
    mfInvested += totalCost;
  });

  return {
    marketValue: mfMarketValue,
    invested: mfInvested,
    holdings,
  };
}

export default {
  calculateStockLots,
  calculateMFLots,
};