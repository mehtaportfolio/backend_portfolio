/**
 * Asset Service
 * Handles data fetching for Bank, NPS, BDM, EPF, PPF assets
 */

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

/**
 * Get Bank Transactions
 * @returns {Promise<object>} - Bank data with grouped summaries
 */
export async function getBankData() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'bank_transactions', {
      select: 'id, account_name, bank_name, account_type, txn_date, amount',
      order: { column: 'txn_date', ascending: false },
    });

    if (error) {
      console.error('Bank data fetch error:', error);
      throw error;
    }

    // Get latest balance per account (account_name + bank_name + account_type)
    const latestBalances = {};
    const groupedByMonth = {};

    (data || []).forEach((txn) => {
      const key = `${txn.account_name}___${txn.bank_name}___${txn.account_type}`;

      // Latest balances
      if (!latestBalances[key]) {
        latestBalances[key] = {
          ...txn,
          amount: toNumber(txn.amount),
        };
      }

      // Group by month - SUM all amounts for the same key
      const dateStr = typeof txn.txn_date === 'string' ? txn.txn_date : txn.txn_date?.toISOString?.() || '';
      const ym = dateStr.slice(0, 7);
      if (!groupedByMonth[ym]) groupedByMonth[ym] = {};
      if (!groupedByMonth[ym][key]) {
        groupedByMonth[ym][key] = {
          ...txn,
          amount: toNumber(txn.amount),
        };
      } else {
        // Accumulate amounts for duplicate keys in the same month
        groupedByMonth[ym][key].amount += toNumber(txn.amount);
      }
    });

    // Calculate summaries
    const months = Object.keys(groupedByMonth).sort((a, b) => b.localeCompare(a));
    const currentMonth = months[0] || null;
    const prevMonth = months[1] || null;

    const sumByTypeForMonth = (month, type) => {
      if (!month || !groupedByMonth[month]) return 0;
      return Object.values(groupedByMonth[month])
        .filter((t) => t.account_type === type)
        .reduce((acc, t) => acc + toNumber(t.amount), 0);
    };

    const summary = {
      Savings: {
        current: sumByTypeForMonth(currentMonth, 'Savings'),
        diff: sumByTypeForMonth(currentMonth, 'Savings') - sumByTypeForMonth(prevMonth, 'Savings'),
      },
      Demat: {
        current: sumByTypeForMonth(currentMonth, 'Demat'),
        diff: sumByTypeForMonth(currentMonth, 'Demat') - sumByTypeForMonth(prevMonth, 'Demat'),
      },
    };

    return {
      transactions: data || [],
      latestBalances,
      groupedByMonth,
      summary,
      currentMonth,
      prevMonth,
    };
  } catch (error) {
    console.error('Error in getBankData:', error);
    throw error;
  }
}

/**
 * Get NPS Data
 * @returns {Promise<object>} - NPS transactions and fund master data
 */
export async function getNPSData() {
  try {
    const [{ data: npsTransactions, error: txnError }, { data: fundMaster, error: fundError }, { data: contributions, error: contribError }] = await Promise.all([
      fetchAllRows(supabase, 'nps_transactions', {
        select: 'id, account_name, fund_name, date, nav, units, transaction_type',
      }),
      fetchAllRows(supabase, 'nps_pension_fund_master', {
        select: 'fund_name, cmp, lcp',
      }),
      fetchAllRows(supabase, 'nps_contributions', {
        select: 'id, date, amount',
      }),
    ]);

    if (txnError || fundError || contribError) {
      console.error('NPS data fetch error:', { txnError, fundError, contribError });
      throw txnError || fundError || contribError;
    }

    // Compute amount for transactions as units * nav
    const transactionsWithAmount = (npsTransactions || []).map((txn) => ({
      ...txn,
      amount: toNumber(txn.units) * toNumber(txn.nav),
    }));

    // Contributions already have amount
    const contributionsWithAmount = (contributions || []).map((contrib) => ({
      ...contrib,
      amount: toNumber(contrib.amount),
    }));

    // Build fund master map
    const fundMasterMap = {};
    (fundMaster || []).forEach((f) => {
      const key = String(f.fund_name || f.scheme_name || '').trim();
      fundMasterMap[key] = {
        cmp: toNumber(f.cmp),
        lcp: toNumber(f.lcp),
        fund_name: f.fund_name,
        scheme_name: f.scheme_name,
      };
    });

    // Group transactions by fund_name and process with FIFO logic
    const holdingsByFund = {};
    (npsTransactions || []).forEach((txn) => {
      const fundName = String(txn.fund_name || '').trim();
      const master = fundMasterMap[fundName];
      if (!master) return;

      if (!holdingsByFund[fundName]) {
        holdingsByFund[fundName] = {
          fund_name: fundName,
          units: 0,
          invested: 0,
          currentValue: 0,
          dayChange: 0,
          cmp: master.cmp,
          lcp: master.lcp,
          transactions: [],
        };
      }
      holdingsByFund[fundName].transactions.push(txn);
    });

    // Process each fund with FIFO logic to calculate remaining holdings
    Object.values(holdingsByFund).forEach((holding) => {
      const master = fundMasterMap[holding.fund_name];
      if (!master) return;

      // Sort transactions chronologically
      holding.transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

      // FIFO lots for remaining units
      const lots = [];
      let totalInvested = 0;

      holding.transactions.forEach((txn) => {
        const units = toNumber(txn.units);
        const nav = toNumber(txn.nav);
        const transactionType = String(txn.transaction_type || '').toLowerCase();

        if (transactionType.includes('buy') && units > 0) {
          // Buy transaction - add to lots
          lots.push({ units: units, nav: nav, date: new Date(txn.date) });
          totalInvested += units * nav;
        } else if (transactionType.includes('sell') && units > 0) {
          // Sell transaction - consume from oldest lots (FIFO)
          let remainingToSell = units;
          while (remainingToSell > 0 && lots.length > 0) {
            const oldestLot = lots[0];
            if (oldestLot.units <= remainingToSell) {
              // Consume entire lot
              totalInvested -= oldestLot.units * oldestLot.nav;
              remainingToSell -= oldestLot.units;
              lots.shift();
            } else {
              // Consume partial lot
              totalInvested -= remainingToSell * oldestLot.nav;
              oldestLot.units -= remainingToSell;
              remainingToSell = 0;
            }
          }
        }
      });

      // Calculate remaining units from lots
      const remainingUnits = lots.reduce((sum, lot) => sum + lot.units, 0);
      holding.units = remainingUnits;
      holding.invested = totalInvested;
      holding.currentValue = remainingUnits * holding.cmp;
      holding.dayChange = remainingUnits * (holding.cmp - holding.lcp);
    });

    // Calculate summary
    const summary = {
      invested: Object.values(holdingsByFund).reduce((sum, h) => sum + h.invested, 0),
      currentValue: Object.values(holdingsByFund).reduce((sum, h) => sum + h.currentValue, 0),
      dayChange: Object.values(holdingsByFund).reduce((sum, h) => sum + h.dayChange, 0),
    };

    // Build fund CMP map (legacy)
    const fundCmpMap = new Map(Object.entries(fundMasterMap).map(([k, v]) => [k, v.cmp]));

    return {
      transactions: transactionsWithAmount,
      fundMaster: fundMaster || [],
      contributions: contributionsWithAmount,
      fundCmpMap: Object.fromEntries(fundCmpMap),
      holdings: Object.values(holdingsByFund),
      summary,
    };
  } catch (error) {
    console.error('Error in getNPSData:', error);
    throw error;
  }
}

/**
 * Get BDM Data
 * @returns {Promise<object>} - BDM transactions with categorization
 */
export async function getBDMData() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'bdm_transactions', {
      select: 'id, account_name, amount, date, transaction_type, category',
      order: { column: 'date', ascending: false },
    });

    if (error) {
      console.error('BDM data fetch error:', error);
      throw error;
    }

    // Categorize transactions
    const categorized = {
      Credit: [],
      Debit: [],
    };

    (data || []).forEach((txn) => {
      const txnType = String(txn.transaction_type || '').toUpperCase();
      if (txnType.includes('CREDIT')) {
        categorized.Credit.push(txn);
      } else if (txnType.includes('DEBIT')) {
        categorized.Debit.push(txn);
      }
    });

    return {
      transactions: data || [],
      categorized,
    };
  } catch (error) {
    console.error('Error in getBDMData:', error);
    throw error;
  }
}

/**
 * Get EPF Data
 * @returns {Promise<object>} - EPF transactions and aggregates
 */
export async function getEPFData() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'epf_transactions', {
      select: 'id, employee_share, employer_share, pension_share, invest_type, contribution_date, company_name',
      order: { column: 'contribution_date', ascending: false },
    });

    if (error) {
      console.error('EPF data fetch error:', error);
      throw error;
    }

    // Aggregate by company
    const byCompany = {};
    let totalEmployee = 0;
    let totalEmployer = 0;
    let totalPension = 0;

    (data || []).forEach((txn) => {
      const company = txn.company_name || 'Unknown';
      if (!byCompany[company]) {
        byCompany[company] = {
          employee: 0,
          employer: 0,
          pension: 0,
          count: 0,
        };
      }

      const emp = toNumber(txn.employee_share);
      const empr = toNumber(txn.employer_share);
      const pens = toNumber(txn.pension_share);

      byCompany[company].employee += emp;
      byCompany[company].employer += empr;
      byCompany[company].pension += pens;
      byCompany[company].count += 1;

      totalEmployee += emp;
      totalEmployer += empr;
      totalPension += pens;
    });

    return {
      transactions: data || [],
      byCompany,
      summary: {
        totalEmployee,
        totalEmployer,
        totalPension,
        total: totalEmployee + totalEmployer + totalPension,
      },
    };
  } catch (error) {
    console.error('Error in getEPFData:', error);
    throw error;
  }
}

/**
 * Get PPF Data
 * @returns {Promise<object>} - PPF transactions and account summaries
 */
export async function getPPFData() {
  try {
    const { data, error } = await supabase
      .from('ppf_transactions')
      .select('id, account_name, txn_date, amount, transaction_type, account_type')
      .order('txn_date', { ascending: true });

    if (error) {
      console.error('[AssetService] PPF data fetch error:', error);
      throw error;
    }


    // Group by account
    const byAccount = {};
    let totalInvested = 0;
    let totalInterest = 0;

    (data || []).forEach((txn) => {
      const account = txn.account_name || 'Unknown';
      if (!byAccount[account]) {
        byAccount[account] = {
          transactions: [],
          invested: 0,
          interest: 0,
          current: 0,
          accountType: txn.account_type,
        };
      }

      byAccount[account].transactions.push(txn);

      const amount = toNumber(txn.amount);
      const tt = String(txn.transaction_type || '').toLowerCase();

      if (tt.includes('deposit')) {
        byAccount[account].invested += amount;
        totalInvested += amount;
      } else if (tt.includes('interest')) {
        byAccount[account].interest += amount;
        totalInterest += amount;
      }
    });

    // Calculate current balance
    Object.values(byAccount).forEach((account) => {
      account.current = account.invested + account.interest;
    });

    return {
      transactions: data || [],
      byAccount,
      summary: {
        totalInvested,
        totalInterest,
        totalCurrent: totalInvested + totalInterest,
      },
    };
  } catch (error) {
    console.error('Error in getPPFData:', error);
    throw error;
  }
}

/**
 * XIRR Calculation Helper
 * @param {Array} cashflows - Array of {amount, date} objects
 * @returns {number|null} - XIRR percentage or null if insufficient data
 */
function calculateXIRR(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;

  const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365;
  const sorted = cashflows
    .map((cf) => ({
      amount: toNumber(cf.amount),
      date: typeof cf.date === 'string' ? new Date(cf.date) : cf.date,
    }))
    .sort((a, b) => a.date - b.date);

  const t0 = sorted[0].date;
  const npv = (rate) =>
    sorted.reduce(
      (acc, cf) => acc + cf.amount / Math.pow(1 + rate, (cf.date - t0) / MS_PER_YEAR),
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
 * Get Mutual Fund Data
 * @returns {Promise<object>} - MF transactions, fund master, and processed holdings
 */
export async function getMFData() {
  try {
    const [
      { data: mfTransactions, error: txnError },
      { data: fundMaster, error: fundError },
      { data: sipDetails, error: sipError },
    ] = await Promise.all([
      fetchAllRows(supabase, 'mf_transactions', {
        select: 'id, date, units, nav, account_name, fund_short_name, transaction_type',
        order: { column: 'date', ascending: true },
      }),
      fetchAllRows(supabase, 'fund_master', {
        select: '*',
      }),
      fetchAllRows(supabase, 'sip_details', {
        select: '*',
      }),
    ]);

    if (txnError || fundError || sipError) {
      console.error('MF data fetch error:', { txnError, fundError, sipError });
      throw txnError || fundError || sipError;
    }

    const txns = mfTransactions || [];
    const masters = fundMaster || [];
    const sips = sipDetails || [];

    // Build maps
    const masterMap = {};
    masters.forEach((m) => {
      const key = (m.fund_short_name || '').trim();
      masterMap[key] = m;
    });

    const sipMap = {};
    sips.forEach((sip) => {
      const key = (sip.fund_short_name || '').trim();
      if (!sipMap[key]) sipMap[key] = [];
      sipMap[key].push(sip);
    });

    // Build FIFO lots for open positions
    const openLotsByFundAccount = {}; // key: "${fund}||${account}"
    const closedSplits = []; // Buy/sell pairs for closed analysis

    const norm = (s) => (s || '').trim();
    const byFundAccount = {};

    txns.forEach((t) => {
      const key = `${norm(t.fund_short_name)}||${t.account_name || ''}`;
      if (!byFundAccount[key]) byFundAccount[key] = [];
      byFundAccount[key].push(t);
    });

    // Process each fund+account stream
    Object.entries(byFundAccount).forEach(([key, stream]) => {
      stream.sort((a, b) => new Date(a.date) - new Date(b.date));
      const lots = [];

      stream.forEach((t) => {
        const tt = String(t.transaction_type || '').toLowerCase();
        const units = toNumber(t.units);
        const nav = toNumber(t.nav);
        const dt = t.date;

        if (!units || !nav) return;

        if (tt === 'buy') {
          lots.push({ units, nav, date: dt, id: t.id });
        } else if (tt === 'sell') {
          let remaining = units;
          while (remaining > 0 && lots.length) {
            const lot = lots[0];
            const take = Math.min(remaining, lot.units);
            closedSplits.push({
              fund_short_name: norm(t.fund_short_name),
              quantity: take,
              buy_price: lot.nav,
              sell_price: nav,
              buy_date: lot.date,
              sell_date: dt,
              account_name: t.account_name || '',
            });
            lot.units -= take;
            remaining -= take;
            if (lot.units <= 1e-8) lots.shift();
          }
        }
      });

      // Remaining lots are open
      lots.forEach((lot) => {
        if (lot.units > 1e-8) {
          openLotsByFundAccount[key] = (openLotsByFundAccount[key] || []).concat({
            units: lot.units,
            buy_nav: lot.nav,
            buy_date: lot.date,
            id: lot.id,
          });
        }
      });
    });

    // Build holdings per fund
    const holdingsByFund = {};
    Object.entries(openLotsByFundAccount).forEach(([key, lots]) => {
      const [fundName, accountName] = key.split('||');
      const master = masterMap[fundName];
      if (!master) return;

      const cmp = toNumber(master.cmp);
      const lcp = toNumber(master.lcp);

      let invested = 0;
      let units = 0;
      const cashflows = [];

      lots.forEach((lot) => {
        const lotUnits = toNumber(lot.units);
        const lotNav = toNumber(lot.buy_nav);
        invested += lotUnits * lotNav;
        units += lotUnits;
        cashflows.push({ amount: -(lotUnits * lotNav), date: lot.buy_date });
      });

      const currentValue = units * cmp;
      const dayChange = units * (cmp - lcp);
      const absReturn = currentValue - invested;
      const returnPct = invested > 0 ? (absReturn / invested) * 100 : 0;
      cashflows.push({ amount: currentValue, date: new Date() });
      const xirr = calculateXIRR(cashflows);

      if (!holdingsByFund[fundName]) {
        holdingsByFund[fundName] = {
          fund_short_name: fundName,
          fund_full_name: master.fund_full_name,
          category: master.category,
          amc_name: master.amc_name,
          cmp,
          lcp,
          units: 0,
          invested: 0,
          currentValue: 0,
          dayChange: 0,
          absReturn: 0,
          returnPct: 0,
          xirr: null,
          accounts: [],
          lots: [],
        };
      }

      const holding = holdingsByFund[fundName];
      holding.units += units;
      holding.invested += invested;
      holding.currentValue += currentValue;
      holding.dayChange += dayChange;
      holding.absReturn += absReturn;
      holding.accounts.push(accountName);
      holding.lots.push(...lots.map((l) => ({ ...l, account_name: accountName })));
    });

    // Recalculate aggregated stats
    Object.values(holdingsByFund).forEach((holding) => {
      const cashflows = [];
      holding.lots.forEach((lot) => {
        const lotUnits = toNumber(lot.units);
        const lotNav = toNumber(lot.buy_nav);
        cashflows.push({ amount: -(lotUnits * lotNav), date: lot.buy_date });
      });
      holding.returnPct = holding.invested > 0 ? (holding.absReturn / holding.invested) * 100 : 0;
      if (holding.currentValue > 0) {
        cashflows.push({ amount: holding.currentValue, date: new Date() });
      }
      holding.xirr = calculateXIRR(cashflows);
      holding.accounts = Array.from(new Set(holding.accounts));
    });

    // Get unique accounts
    const uniqueAccounts = Array.from(new Set(txns.map((t) => t.account_name).filter(Boolean))).sort();

    // Color palette for categories
    const categories = Array.from(new Set(masters.map((m) => m.category).filter(Boolean))).sort();
    const palette = [
      { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200' },
      { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200' },
      { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200' },
      { bg: 'bg-teal-100', text: 'text-teal-700', border: 'border-teal-200' },
      { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200' },
      { bg: 'bg-pink-100', text: 'text-pink-700', border: 'border-pink-200' },
      { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-200' },
      { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-200' },
      { bg: 'bg-lime-100', text: 'text-lime-700', border: 'border-lime-200' },
      { bg: 'bg-cyan-100', text: 'text-cyan-700', border: 'border-cyan-200' },
      { bg: 'bg-rose-100', text: 'text-rose-700', border: 'border-rose-200' },
      { bg: 'bg-sky-100', text: 'text-sky-700', border: 'border-sky-200' },
    ];
    const categoryColorMap = {};
    categories.forEach((cat, idx) => {
      const c = palette[idx % palette.length];
      categoryColorMap[cat] = `${c.bg} ${c.text} ${c.border}`;
    });

    // SIP account amounts
    const sipAccountAmounts = {};
    sips.forEach((sip) => {
      const accName = sip.account_name || 'Unknown';
      const amt = toNumber(sip.amount);
      sipAccountAmounts[accName] = (sipAccountAmounts[accName] || 0) + amt;
    });

    // Calculate summary
    const summary = {
      invested: Object.values(holdingsByFund).reduce((sum, h) => sum + h.invested, 0),
      currentValue: Object.values(holdingsByFund).reduce((sum, h) => sum + h.currentValue, 0),
      dayChange: Object.values(holdingsByFund).reduce((sum, h) => sum + h.dayChange, 0),
    };

    return {
      transactions: txns,
      fundMaster: masters,
      sipDetails: sips,
      holdings: Object.values(holdingsByFund),
      closedSplits,
      openLotsByFundAccount,
      accounts: uniqueAccounts,
      categoryColorMap,
      sipAccountAmounts,
      summary,
    };
  } catch (error) {
    console.error('Error in getMFData:', error);
    throw error;
  }
}