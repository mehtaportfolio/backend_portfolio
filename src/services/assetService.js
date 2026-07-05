/**
 * Asset Service
 * Handles data fetching for Bank, NPS, BDM, EPF, PPF assets
 */

import {
  fetchAllRows,
  getResolvedAccountNames,
  insertRows,
  updateRows,
  deleteRows,
} from '../db/queries.js';
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
      order: { column: 'txn_date', ascending: false }
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
        select: 'id, account_name, fund_name, scheme_name, date, nav, units, transaction_type',
      }),
      fetchAllRows(supabase, 'nps_pension_fund_master', {
        select: 'fund_name, scheme_name, cmp, lcp',
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
      const cmp = toNumber(f.cmp);
      const lcp = toNumber(f.lcp);
      const entry = { cmp, lcp, fund_name: f.fund_name, scheme_name: f.scheme_name };
      
      if (f.scheme_name) fundMasterMap[String(f.scheme_name).trim()] = entry;
      if (f.fund_name) fundMasterMap[String(f.fund_name).trim()] = entry;
    });

    // Group transactions by scheme_name (primary) or fund_name (fallback) and process with FIFO logic
    const holdingsByFund = {};
    (npsTransactions || []).forEach((txn) => {
      const schemeName = String(txn.scheme_name || '').trim();
      const fundName = String(txn.fund_name || '').trim();
      const key = schemeName || fundName;
      if (!key) return;

      const master = fundMasterMap[schemeName] || fundMasterMap[fundName];
      if (!master) return;

      if (!holdingsByFund[key]) {
        holdingsByFund[key] = {
          fund_name: master.fund_name || key,
          scheme_name: master.scheme_name || key,
          units: 0,
          invested: 0,
          currentValue: 0,
          dayChange: 0,
          cmp: master.cmp,
          lcp: master.lcp,
          transactions: [],
        };
      }
      holdingsByFund[key].transactions.push(txn);
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
      order: { column: 'date', ascending: false }
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
 * Get Bank Metadata (Account and Bank names)
 */
export async function getBankMetadata() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'bank_transactions', {
      select: 'account_name, bank_name',
      // Single user: fetch all
    });
    if (error) throw error;
    
    const accounts = [...new Set(data.map((d) => d.account_name).filter(Boolean))].sort();
    const banks = [...new Set(data.map((d) => d.bank_name).filter(Boolean))].sort();
    
    return { accounts, banks };
  } catch (error) {
    console.error('Error in getBankMetadata:', error);
    throw error;
  }
}

/**
 * Add Bank Transaction
 */
export async function addBankTransaction(transaction) {
  try {
    const { data, error } = await insertRows(supabase, 'bank_transactions', transaction);
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in addBankTransaction:', error);
    throw error;
  }
}

/**
 * Add Bulk Bank Transactions
 */
export async function addBulkBankTransactions(transactions) {
  try {
    const { data, error } = await insertRows(supabase, 'bank_transactions', transactions);
    if (error) throw error;
    return { success: true, count: data?.length };
  } catch (error) {
    console.error('Error in addBulkBankTransactions:', error);
    throw error;
  }
}

/**
 * Get Bank Transactions for a date range
 */
export async function getBankTransactionsByRange(startDate, endDate) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'bank_transactions', {
      select: '*',
      order: { column: 'txn_date', ascending: false },
      filters: [
        (q) => q.gte('txn_date', startDate),
        (q) => q.lte('txn_date', endDate)
      ]
    });
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error in getBankTransactionsByRange:', error);
    throw error;
  }
}

/**
 * Get Bank Snapshots with User Master mapping
 */
export async function getBankSnapshots() {
  try {
    const [{ data: snapshots, error: sError }, { data: userMaster, error: uError }] = await Promise.all([
      fetchAllRows(supabase, 'bank_balance_snapshots', {
        select: 'id, bank_name, account_number, balance, captured_at'
      }),
      fetchAllRows(supabase, 'user_master', {
        select: 'account_name, bank_name, account_number'
      })
    ]);

    if (sError) throw sError;
    if (uError) throw uError;

    // Join data in JS based on last 3 digits of account_number
    const result = (snapshots || []).map(snapshot => {
      const sAcc = String(snapshot.account_number || "").trim();
      if (!sAcc) return null;
      
      const sLast3 = sAcc.slice(-3);
      
      const user = (userMaster || []).find(u => {
        const uAcc = String(u.account_number || "").trim();
        return uAcc && uAcc.slice(-3) === sLast3;
      });

      if (!user) return null;

      return {
        id: snapshot.id,
        account_name: user.account_name,
        bank_name: user.bank_name,
        account_number: snapshot.account_number,
        account_type: 'Savings',
        balance: snapshot.balance,
        captured_at: snapshot.captured_at,
      };
    }).filter(Boolean);

    return result;
  } catch (error) {
    console.error('Error in getBankSnapshots:', error);
    throw error;
  }
}

export async function updateBankBalanceSnapshot(id, updates) {
  try {
    const { data, error } = await updateRows(
      supabase,
      'bank_balance_snapshots',
      {
        bank_name: updates.bank_name ?? undefined,
        account_number: updates.account_number ?? undefined,
        balance: updates.balance ?? undefined,
        captured_at: updates.captured_at ?? undefined,
      },
      { id }
    );

    if (error) throw error;
    return { success: true, data: data?.[0] || null };
  } catch (error) {
    console.error('Error in updateBankBalanceSnapshot:', error);
    throw error;
  }
}

export async function deleteBankBalanceSnapshot(id) {
  try {
    const { error } = await deleteRows(supabase, 'bank_balance_snapshots', { id });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error in deleteBankBalanceSnapshot:', error);
    throw error;
  }
}


/**
 * Get PPF Data
 */
export async function getPPFData() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'ppf_transactions', {
      select: 'id, account_name, txn_date, amount, transaction_type, account_type',
      order: { column: 'txn_date', ascending: true }
    });

    if (error) {
      console.error('[AssetService] PPF data fetch error:', error);
      throw error;
    }


    // Group by type and account
    const byType = {
      ppf: {},
      fd: {}
    };
    const typeSummaries = {
      ppf: { invested: 0, interest: 0, current: 0 },
      fd: { invested: 0, interest: 0, current: 0 }
    };
    let totalInvested = 0;
    let totalInterest = 0;

    (data || []).forEach((txn) => {
      const type = String(txn.account_type || 'ppf').toLowerCase();
      const account = txn.account_name || 'Unknown';
      
      if (!byType[type]) {
        byType[type] = {};
        typeSummaries[type] = { invested: 0, interest: 0, current: 0 };
      }
      
      if (!byType[type][account]) {
        byType[type][account] = {
          transactions: [],
          invested: 0,
          interest: 0,
          current: 0,
          accountType: txn.account_type,
        };
      }

      byType[type][account].transactions.push(txn);

      const amount = toNumber(txn.amount);
      const tt = String(txn.transaction_type || '').toLowerCase();

      if (tt.includes('deposit')) {
        byType[type][account].invested += amount;
        typeSummaries[type].invested += amount;
        totalInvested += amount;
      } else if (tt.includes('interest')) {
        byType[type][account].interest += amount;
        typeSummaries[type].interest += amount;
        totalInterest += amount;
      } else if (tt.includes('withdrawal')) {
        byType[type][account].invested -= amount;
        typeSummaries[type].invested -= amount;
        totalInvested -= amount;
      }
    });

    // Calculate current balance for all accounts and types
    Object.keys(byType).forEach((type) => {
      Object.values(byType[type]).forEach((account) => {
        account.current = account.invested + account.interest;
      });
      typeSummaries[type].current = typeSummaries[type].invested + typeSummaries[type].interest;
    });

    return {
      transactions: data || [],
      byType,
      typeSummaries,
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
 * Get MF Account Names
 */
export async function getMFAccountNames() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'mf_transactions', {
      select: 'account_name'
    });
    if (error) throw error;
    return [...new Set(data.map((d) => d.account_name).filter(Boolean))].sort();
  } catch (error) {
    console.error('Error in getMFAccountNames:', error);
    throw error;
  }
}

/**
 * Add MF Transaction
 */
export async function addMFTransaction(transaction) {
  try {
    const { data, error } = await insertRows(supabase, 'mf_transactions', transaction);
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in addMFTransaction:', error);
    throw error;
  }
}

/**
 * Add Bulk MF Transactions
 */
export async function addBulkMFTransactions(transactions) {
  try {
    const { data, error } = await insertRows(supabase, 'mf_transactions', transactions);
    if (error) throw error;
    return { success: true, count: data?.length };
  } catch (error) {
    console.error('Error in addBulkMFTransactions:', error);
    throw error;
  }
}

/**
 * Add MF Master
 */
export async function addMFMaster(fundData) {
  try {
    const { data, error } = await insertRows(supabase, 'fund_master', fundData);
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in addMFMaster:', error);
    throw error;
  }
}

/**
 * Add MF SIP
 */
export async function addMFSIP(sipData) {
  try {
    const { data, error } = await insertRows(supabase, 'sip_details', sipData);
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in addMFSIP:', error);
    throw error;
  }
}

/**
 * Update MF SIP
 */
export async function updateMFSIP(id, updates) {
  try {
    const { data, error } = await updateRows(supabase, 'sip_details', updates, { id });
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in updateMFSIP:', error);
    throw error;
  }
}

/**
 * Delete MF SIP
 */
export async function deleteMFSIP(id) {
  try {
    const { error } = await deleteRows(supabase, 'sip_details', { id });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error in deleteMFSIP:', error);
    throw error;
  }
}

/**
 * Update MF Transaction
 */
export async function updateMFTransaction(id, updates) {
  try {
    const { data, error } = await updateRows(supabase, 'mf_transactions', updates, { id });
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in updateMFTransaction:', error);
    throw error;
  }
}

/**
 * Delete MF Transaction
 */
export async function deleteMFTransaction(id) {
  try {
    const { error } = await deleteRows(supabase, 'mf_transactions', { id });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error in deleteMFTransaction:', error);
    throw error;
  }
}

/**
 * Get distinct company/account names for any asset table
 */
export async function getAssetDistinctNames(tableName, columnName) {
  try {
    const { data, error } = await fetchAllRows(supabase, tableName, {
      select: columnName
    });
    if (error) throw error;
    return [...new Set(data.map((d) => d[columnName]).filter(Boolean))].sort();
  } catch (error) {
    console.error(`Error in getAssetDistinctNames for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Add Bulk Asset Transactions
 */
export async function addBulkAssetTransactions(tableName, transactions) {
  try {
    const { data, error } = await insertRows(supabase, tableName, transactions);
    if (error) throw error;
    return { success: true, count: data?.length };
  } catch (error) {
    console.error(`Error in addBulkAssetTransactions for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Get Asset Transactions by range
 */
export async function getAssetTransactionsByRange(tableName, dateColumn, startDate, endDate) {
  try {
    const { data, error } = await fetchAllRows(supabase, tableName, {
      select: '*',
      filters: [
        (q) => q.gte(dateColumn, startDate),
        (q) => q.lte(dateColumn, endDate)
      ],
      order: { column: dateColumn, ascending: false }
    });
    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error in getAssetTransactionsByRange for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Get Latest Date for an asset table
 */
export async function getAssetLatestDate(tableName, dateColumn = 'date') {
  try {
    const { data, error } = await fetchAllRows(supabase, tableName, {
      select: dateColumn,
      order: { column: dateColumn, ascending: false },
      limit: 1
    });

    if (error) throw error;
    return data && data.length > 0 ? data[0][dateColumn] : null;
  } catch (error) {
    console.error(`Error in getAssetLatestDate for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Add Asset Contribution (e.g. NPS)
 */
export async function addAssetContribution(tableName, contribution) {
  try {
    const { data, error } = await insertRows(supabase, tableName, contribution);
    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error(`Error in addAssetContribution for ${tableName}:`, error);
    throw error;
  }
}

/**
 * NPS Master Data
 */
export async function getNPSMasterData() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'nps_pension_fund_master', {
      select: '*',
      order: { column: 'scheme_name', ascending: true }
    });
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error in getNPSMasterData:', error);
    throw error;
  }
}

/**
 * Get Raw NPS Transactions (from nps_raw_temp)
 */
export async function getRawNPSTransactions() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'nps_raw_temp', {
      select: '*',
      order: { column: 'date', ascending: false }
    });
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error in getRawNPSTransactions:', error);
    throw error;
  }
}

/**
 * Delete All MF CAS Entries
 */
export async function deleteAllMFCasEntries() {
  try {
    const { error } = await deleteRows(supabase, 'mf_cas', (q) => q.neq('id', -1));
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error in deleteAllMFCasEntries:', error);
    throw error;
  }
}

/**
 * Get MF CAS Entries
 */
export async function getMFCasEntries() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'mf_cas', {
      select: '*',
      order: { column: 'created_at', ascending: false }
    });
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error in getMFCasEntries:', error);
    throw error;
  }
}

/**
 * Get MF Raw CAS Entries
 */
export async function getMFRawCasEntries() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'mf_raw_cas', {
      select: '*',
      order: { column: 'created_at', ascending: false }
    });
    if (error) throw error;
    return (data || []).filter((row) => {
      const fundName = String(row?.fund_full_name || "").trim().toLowerCase();
      return fundName !== 'unknown fund';
    });
  } catch (error) {
    console.error('Error in getMFRawCasEntries:', error);
    throw error;
  }
}
/**
 * Get MF Data
 * @returns {Promise<object>} - MF transactions, master data, and processed holdings
 */
export async function getMFData(priceSource = 'stock_master') {
  try {
    const queries = [
      fetchAllRows(supabase, 'mf_transactions', {
        select: 'id, date, units, nav, account_name, fund_short_name, transaction_type',
        order: { column: 'date', ascending: true }
      }),
      fetchAllRows(supabase, 'fund_master', {
        select: 'id, fund_short_name, amc_name, isin, fund_full_name, category, updated_at, cmp, lcp',
      }),
      fetchAllRows(supabase, 'sip_details', {
        select: '*',
      }),
    ];

    if (priceSource !== 'stock_master') {
      queries.push(fetchAllRows(supabase, 'fund_master_backend', {
        select: 'fund_short_name, nav, last_sync_at',
        order: { column: 'last_sync_at', ascending: false }
      }));
    }

    const results = await Promise.all(queries);

    const mfTransactions = results[0]?.data;
    const fundMaster = results[1]?.data;
    const sipDetails = results[2]?.data;
    const fundMasterBackend = priceSource !== 'stock_master' ? results[3]?.data : null;

    const txns = mfTransactions || [];
    const masters = fundMaster || [];
    const sips = sipDetails || [];

    // Build maps
    const masterMap = {};
    masters.forEach((m) => {
      const key = (m.fund_short_name || '').trim().toUpperCase();
      masterMap[key] = { ...m, lcp: toNumber(m.lcp) || 0 }; 
    });

    // If priceSource is not stock_master, override cmp and lcp from fund_master_backend
    if (priceSource !== 'stock_master' && fundMasterBackend) {
      const groupedBackend = {};
      fundMasterBackend.forEach(m => {
        const name = (m.fund_short_name || '').trim().toUpperCase();
        if (name) {
          if (!groupedBackend[name]) groupedBackend[name] = [];
          groupedBackend[name].push(m);
        }
      });

      Object.entries(groupedBackend).forEach(([name, history]) => {
        if (masterMap[name]) {
          // 🔹 Skip empty/null/zero NAV values to ensure correct CMP/LCP calculation
          const validHistory = history.filter(h => toNumber(h.nav) > 0);
          
          if (validHistory.length > 0) {
            const latestNav = toNumber(validHistory[0].nav);
            // If we have at least two valid records, the second one becomes LCP. 
            // Otherwise, fallback to CMP (Day change = 0)
            const previousNav = validHistory.length > 1 ? toNumber(validHistory[1].nav) : latestNav;
            
            masterMap[name].cmp = latestNav;
            masterMap[name].lcp = previousNav;
          }
        }
      });
    }

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
      const lcp = toNumber(master.lcp || cmp);

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
    const sipAmountByAccount = {};
    const today = new Date();
    const todayYMD = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

    const parseSipDate = (sipDate) => {
      if (!sipDate) return null;
      const raw = sipDate.toString().trim();
      if (!raw) return null;
      if (raw.includes('-') || raw.includes('/')) {
        const parsed = new Date(raw);
        return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
      }
      const day = parseInt(raw, 10);
      if (!Number.isFinite(day) || day <= 0 || day > 31) return null;
      return new Date(today.getFullYear(), today.getMonth(), day).getTime();
    };

    sips.forEach((sip) => {
      const accName = sip.account_name || 'Unknown';
      const amt = toNumber(sip.amount);
      sipAccountAmounts[accName] = (sipAccountAmounts[accName] || 0) + amt;
      const sipDateMs = parseSipDate(sip.sip_date);
      if (sipDateMs !== null && sipDateMs <= todayYMD) {
        sipAmountByAccount[accName] = (sipAmountByAccount[accName] || 0) + amt;
      }
    });

    const currentMonthAmountByAccount = {};
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    txns.forEach((txn) => {
      const accName = txn.account_name || 'Unknown';
      const txnDate = new Date(txn.date);
      if (!Number.isFinite(txnDate.getTime())) return;
      if (txnDate.getFullYear() !== currentYear || txnDate.getMonth() !== currentMonth) return;
      const amount = toNumber(txn.units) * toNumber(txn.nav);
      currentMonthAmountByAccount[accName] = (currentMonthAmountByAccount[accName] || 0) + amount;
    });

    const accountSummaries = uniqueAccounts.map((accountName) => ({
      account_name: accountName,
      totalAmount: sipAccountAmounts[accountName] || 0,
      sipAmount: sipAmountByAccount[accountName] || 0,
      currentMonth: currentMonthAmountByAccount[accountName] || 0,
    }));

    // Calculate summary
    const summary = {
      invested: Object.values(holdingsByFund).reduce((sum, h) => sum + h.invested, 0),
      currentValue: Object.values(holdingsByFund).reduce((sum, h) => sum + h.currentValue, 0),
      dayChange: Object.values(holdingsByFund).reduce((sum, h) => sum + h.dayChange, 0),
    };

    return {
      transactions: txns,
      fundMaster: Object.values(masterMap),
      sipDetails: sips,
      holdings: Object.values(holdingsByFund),
      closedSplits,
      openLotsByFundAccount,
      accounts: uniqueAccounts,
      categoryColorMap,
      sipAccountAmounts,
      accountSummaries,
      summary,
    };
  } catch (error) {
    console.error('Error in getMFData:', error);
    throw error;
  }
}

/**
 * Update Bank Transaction
 */
export async function updateBankTransaction(id, updates) {
  try {
    const { data, error } = await updateRows(supabase, 'bank_transactions', updates, { id });
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in updateBankTransaction:', error);
    throw error;
  }
}

/**
 * Delete Bank Transaction
 */
export async function deleteBankTransaction(id) {
  try {
    const { error } = await deleteRows(supabase, 'bank_transactions', { id });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error in deleteBankTransaction:', error);
    throw error;
  }
}

/**
 * Process Bank Adjustment
 */
export async function processBankAdjustment() {
  try {
    const accountName = "PM"; 
    const bankName = "Other";
    const accountType = "Savings";

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const monthStart = `${year}-${month}-01`;
    const monthEnd = new Date(year, now.getMonth() + 1, 0).toISOString().slice(0, 10);

    const { data: monthTxns, error: monthError } = await fetchAllRows(supabase, "bank_transactions", {
      select: "id",
      filters: [
        (q) => q.eq("account_name", accountName),
        (q) => q.gte("txn_date", monthStart),
        (q) => q.lte("txn_date", monthEnd)
      ],
      limit: 1
    });

    if (monthError) throw monthError;

    if (!monthTxns || monthTxns.length === 0) {
      return { success: false, message: "No bank transactions found for the current month." };
    }

    const { data: otherTxns, error: txnError } = await fetchAllRows(supabase, "other_transactions", {
      select: "transaction_type, amount"
    });

    if (txnError) throw txnError;

    const totalDebit = otherTxns
      .filter(txn => txn.transaction_type?.toLowerCase() === "debit")
      .reduce((sum, txn) => sum + Number(txn.amount || 0), 0);

    const totalCredit = otherTxns
      .filter(txn => txn.transaction_type?.toLowerCase() === "credit")
      .reduce((sum, txn) => sum + Number(txn.amount || 0), 0);

    const adjustmentAmount = totalDebit - totalCredit;

    const { data: existing, error: existingError } = await fetchAllRows(supabase, "bank_transactions", {
      select: "id",
      filters: [
        (q) => q.eq("account_name", accountName),
        (q) => q.eq("is_adjustment", true),
        (q) => q.gte("txn_date", monthStart),
        (q) => q.lte("txn_date", monthEnd)
      ],
      limit: 1
    });

    if (existingError) throw existingError;

    if (existing && existing.length > 0) {
      const { data, error: updateError } = await updateRows(supabase, "bank_transactions", {
        amount: adjustmentAmount,
        note: "Monthly adjustment for Other Transactions (updated)",
        account_type: accountType,
        bank_name: bankName,
      }, { id: existing[0].id });

      if (updateError) throw updateError;
      return { success: true, message: "Monthly adjustment updated successfully!", data: data[0] };
    } else {
      const { data, error: insertError } = await insertRows(supabase, "bank_transactions", {
        account_name: accountName,
        account_type: accountType,
        txn_date: new Date().toISOString().slice(0, 10),
        amount: adjustmentAmount,
        bank_name: bankName,
        note: "Monthly adjustment for Other Transactions",
        is_adjustment: true,
      });

      if (insertError) throw insertError;
      return { success: true, message: "Monthly adjustment added successfully!", data: data[0] };
    }
  } catch (err) {
    console.error("Error in processBankAdjustment:", err);
    throw err;
  }
}

/**
 * Update Asset Transaction (Generic)
 */
export async function updateAssetTransaction(tableName, id, updates) {
  try {
    const { data, error } = await updateRows(supabase, tableName, updates, { id });
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error(`Error in updateAssetTransaction for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Delete Asset Transaction (Generic)
 */
export async function deleteAssetTransaction(tableName, id) {
  try {
    const { error } = await deleteRows(supabase, tableName, { id });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error(`Error in deleteAssetTransaction for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Add Asset Transaction (Generic)
 */
export async function addAssetTransaction(tableName, transaction) {
  try {
    const { data, error } = await insertRows(supabase, tableName, transaction);
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error(`Error in addAssetTransaction for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Get User Master Data
 */
export async function getUserMasterData(assetType) {
  try {
    const { data, error } = await fetchAllRows(supabase, 'user_master', {
      filters: assetType ? [(q) => q.eq('asset_type', assetType)] : []
    });
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error in getUserMasterData:', error);
    throw error;
  }
}

/**
 * Get BDM Account Number
 */
export async function getBDMAccountNumber() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'user_master', {
      select: 'account_number',
      filters: [(q) => q.eq('account_name', 'BDM')],
      limit: 1
    });
    
    if (error) {
      if (error.code === 'PGRST116') return { account_number: '-' };
      throw error;
    }
    return data && data.length > 0 ? data[0] : { account_number: '-' };
  } catch (error) {
    console.error('Error in getBDMAccountNumber:', error);
    throw error;
  }
}

/**
 * Get MF explorer funds metadata
 */
export async function getMFExplorerFunds() {
  try {
    const { data, error } = await fetchAllRows(supabase, "mf_explorer_funds", {
      select: "amfi_code, category, amc_name, scheme_name",
      filters: [(q) => q.eq("active", true)]
    });

    if (error) {
      console.error('[AssetService] MF explorer funds fetch error:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error in getMFExplorerFunds:', error);
    throw error;
  }
}

/**
 * Update User Master Data
 */
export async function updateUserMasterData(id, updates) {
  try {
    const { data, error } = await updateRows(supabase, 'user_master', updates, { id });
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in updateUserMasterData:', error);
    throw error;
  }
}

/**
 * Add User Master Data
 */
export async function addUserMasterData(masterData) {
  try {
    const { data, error } = await insertRows(supabase, 'user_master', masterData);
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in addUserMasterData:', error);
    throw error;
  }
}

/**
 * Delete User Master Data
 */
export async function deleteUserMasterData(id) {
  try {
    const { error } = await deleteRows(supabase, 'user_master', { id });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    console.error('Error in deleteUserMasterData:', error);
    throw error;
  }
}

/**
 * Get User Details
 */
export async function getUserDetails() {
  try {
    const { data, error } = await fetchAllRows(supabase, 'user_details', {
      filters: [(q) => q.eq('id', 1)],
      limit: 1
    });
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (error) {
    console.error('Error in getUserDetails:', error);
    throw error;
  }
}

/**
 * Update User Details
 */
export async function updateUserDetails(updates) {
  try {
    const { data, error } = await updateRows(supabase, 'user_details', updates, { id: 1 }); // Following frontend pattern
    if (error) throw error;
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('Error in updateUserDetails:', error);
    throw error;
  }
}

/**
 * Get specialized Profile Data (Accounts + User Details)
 * This replicates the direct Supabase logic from profile_old.js
 */
export async function getProfileData() {
  try {
    // 1. Fetch equity accounts with case-insensitive ilike filter
    const { data: accounts, error: accountsError } = await fetchAllRows(supabase, 'user_master', {
      filters: [(q) => q.ilike('asset_type', 'equity')]
    });

    if (accountsError) throw accountsError;

    // 2. Fetch user details (hardcoded id=1 as per existing pattern)
    const { data: userDetailsArr, error: detailsError } = await fetchAllRows(supabase, 'user_details', {
      filters: [(q) => q.eq('id', 1)],
      limit: 1
    });

    const userDetails = userDetailsArr && userDetailsArr.length > 0 ? userDetailsArr[0] : null;

    // If detailsError is just PGRST116 (no rows), we can still return accounts
    const finalDetails = detailsError && detailsError.code !== 'PGRST116' ? null : userDetails;
    if (detailsError && detailsError.code !== 'PGRST116') throw detailsError;

    return {
      accounts: accounts || [],
      userDetails: finalDetails
    };
  } catch (error) {
    console.error('Error in getProfileData:', error);
    throw error;
  }
}

/**
 * Get Latest Updates for Asset List
 */
export async function getLatestUpdates() {
  try {
    const tables = [
      { key: 'stock', table: 'stock_master' },
      { key: 'mf', table: 'fund_master' },
      { key: 'nps', table: 'nps_pension_fund_master' }
    ];

    const results = {};
    
    await Promise.all(tables.map(async ({ key, table }) => {
      const { data, error } = await fetchAllRows(supabase, table, {
        select: 'updated_at',
        filters: [(q) => q.not('updated_at', 'is', null)],
        order: { column: 'updated_at', ascending: false },
        limit: 1
      });
      
      if (!error && data && data.length > 0) {
        results[key] = data[0].updated_at;
      } else {
        results[key] = null;
      }
    }));

    return results;
  } catch (error) {
    console.error('Error in getLatestUpdates:', error);
    throw error;
  }
}

/**
 * Tables that do not expose account_name for filtering.
 * EPF transactions are global and are aggregated without account_name.
 * Master tables also do not have account_name.
 */
const tablesWithoutAccountName = new Set([
  'epf_transactions', 
  'fund_master', 
  'stock_master', 
  'nps_pension_fund_master',
  'stock_mapping',
  'stock_symbols'
]);

function supportsAccountNameFiltering(tableName) {
  return !tablesWithoutAccountName.has(tableName);
}

/**
 * Get Asset Transactions with Filters (Generic)
 */
export async function getAssetTransactions(tableName, options = {}) {
  try {
    const { select = '*', filters = [], order = { column: 'date', ascending: false } } = options;
    
    const { data, error } = await fetchAllRows(supabase, tableName, {
      select,
      filters: filters.map(f => (q) => q[f.operator || 'eq'](f.column, f.value)),
      order
    });
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error in getAssetTransactions for ${tableName}:`, error);
    throw error;
  }
}

/**
 * Get bulk export data for selected tables
 */
export async function getBulkExportData(tables) {
  try {
    const result = {};

    // Define table configurations
    const tableConfigs = {
      stock_transactions: {
        select: 'id,stock_name,account_name,account_type,equity_type,buy_date,buy_price,quantity,sell_date,sell_price',
        filters: []
      },
      mf_transactions: {
        select: 'id,fund_short_name,account_name,date,transaction_type,units,nav',
        filters: []
      },
      bank_transactions: {
        select: 'id,account_name,txn_date,note,amount,account_type,bank_name',
        filters: []
      },
      epf_transactions: {
        select: 'id,contribution_date,employee_share,employer_share,pension_share,invest_type',
        filters: []
      },
      bdm_transactions: {
        select: 'id,account_name,date,description,amount,transaction_type',
        filters: []
      },
      account_cashflows: {
        select: 'id,account_name,date,notes,amount,transaction_type',
        filters: []
      },
      fund_master: {
        select: 'fund_short_name,fund_full_name,category,amc_name,cmp',
        filters: []
      },
      stock_master: {
        select: 'stock_name,symbol,category,sector,basic_industry,cmp,lcp',
        filters: []
      },
      sip_details: {
        select: 'account_name,fund_short_name,amount,sip_date',
        filters: []
      }
    };

    // Fetch data for each requested table. Use specific select when available, otherwise fetch all columns.
    for (const tableName of tables) {
      try {
        const config = tableConfigs[tableName];
        const selectClause = config ? config.select : '*';
        const filters = config && config.filters ? config.filters.map(f => (q) => q[f.operator || 'eq'](f.column, f.value)) : [];

        const { data, error } = await fetchAllRows(supabase, tableName, {
          select: selectClause,
          filters
        });

        if (error) {
          console.error(`Error fetching ${tableName}:`, error);
          result[tableName] = [];
        } else {
          result[tableName] = data || [];
        }
      } catch (error) {
        console.error(`Error fetching ${tableName}:`, error);
        result[tableName] = [];
      }
    }

    return result;
  } catch (error) {
    console.error('Error in getBulkExportData:', error);
    throw error;
  }
}
