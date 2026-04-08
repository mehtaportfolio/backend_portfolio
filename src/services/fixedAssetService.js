import { calculateBankHoldings, calculatePPFHoldings, calculateEPFHoldings, calculateFDHoldings } from './aggregationService.js';

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Fixed Asset Service for Home Page
 * Aggregates Bank, PPF, EPF, and FD data account-wise
 */
export async function getFixedAssetTotals(supabase, userId) {
  if (!supabase) throw new Error('Supabase client is required');
  if (!userId) throw new Error('User ID is required');

  const userIdArray = Array.isArray(userId) ? userId : [userId];
  const filterFn = (q) => {
    if (userId === 'all') return q;
    return q.in('account_name', userIdArray);
  };

  // Fetch data for these 4 assets
  const [bankRes, ppfRes, epfRes, otherRes] = await Promise.all([
    filterFn(supabase.from('bank_transactions').select('account_name, bank_name, account_type, txn_date, amount')),
    filterFn(supabase.from('ppf_transactions').select('account_name, txn_date, amount, transaction_type, account_type')),
    supabase.from('epf_transactions').select('employee_share, employer_share, pension_share, invest_type, contribution_date'),
    filterFn(supabase.from('other_transactions').select('account_name, transaction_type, amount'))
  ]);

  const bankTxns = bankRes.data || [];
  const ppfTxns = ppfRes.data || [];
  const epfTxns = epfRes.data || [];
  const otherTxns = otherRes.data || [];

  // 1. Bank Account-wise
  const bankAccountTotals = new Map();
  // Using the same "latest transaction per unique key" logic as Asset page
  const sortedBankTxns = [...bankTxns]
    .filter(t => (t.account_name || '').trim().toUpperCase() !== 'BDM')
    .sort((a, b) => new Date(b.txn_date) - new Date(a.txn_date));
  
  const seenBankKeys = new Set();
  sortedBankTxns.forEach(txn => {
    const type = String(txn.account_type || '').toLowerCase();
    if (type === 'savings' || type === 'demat') {
      const key = `${txn.account_name}___${txn.bank_name}___${txn.account_type}`;
      if (!seenBankKeys.has(key)) {
        seenBankKeys.add(key);
        const accName = txn.account_name || 'Other Accounts';
        if (!bankAccountTotals.has(accName)) {
          bankAccountTotals.set(accName, { marketValue: 0, invested: 0, dayChange: 0 });
        }
        const val = toNumber(txn.amount);
        const stats = bankAccountTotals.get(accName);
        stats.marketValue += val;
        stats.invested += val;
      }
    }
  });

  const totalBankMarketValue = Array.from(bankAccountTotals.values()).reduce((sum, s) => sum + s.marketValue, 0);

  // 2. PPF Account-wise (Only where account_type is 'PPF')
  const ppfAccountTotals = new Map();
  const ppfOnlyTxns = ppfTxns.filter(t => 
    String(t.account_type || '').toLowerCase() === 'ppf' && 
    (t.account_name || '').trim().toUpperCase() !== 'BDM'
  );

  const ppfGroups = ppfOnlyTxns.reduce((acc, txn) => {
    const name = txn.account_name || 'Other Accounts';
    if (!acc[name]) acc[name] = [];
    acc[name].push(txn);
    return acc;
  }, {});

  Object.entries(ppfGroups).forEach(([name, txns]) => {
    const holdings = calculatePPFHoldings(txns);
    ppfAccountTotals.set(name, {
      marketValue: holdings.total,
      invested: holdings.invested,
      dayChange: 0
    });
  });

  // 3. EPF (Overall only - no account_name)
  const epfOverall = calculateEPFHoldings(epfTxns);
  
  // 4. FD (Both other_transactions and ppf_transactions FD type)
  const fdAccountTotals = new Map();
  
  // A. Other Transactions
  const otherNets = {};
  otherTxns.forEach((txn) => {
    const account = txn.account_name || 'Other Accounts';
    if (account.trim().toUpperCase() === 'BDM') return;
    
    const type = txn.transaction_type?.toLowerCase();
    const amt = toNumber(txn.amount);

    if (!otherNets[account]) otherNets[account] = 0;
    if (type === "debit") {
      otherNets[account] += amt;
    } else if (type === "credit") {
      otherNets[account] -= amt;
    }
  });

  Object.entries(otherNets).forEach(([name, net]) => {
    if (!fdAccountTotals.has(name)) {
      fdAccountTotals.set(name, { marketValue: 0, invested: 0, dayChange: 0 });
    }
    const stats = fdAccountTotals.get(name);
    stats.marketValue += net;
    stats.invested += net;
  });

  // B. PPF Transactions (FD Type)
  const fdOnlyTxns = ppfTxns.filter(t => 
    String(t.account_type || '').toLowerCase() === 'fd' && 
    (t.account_name || '').trim().toUpperCase() !== 'BDM'
  );
  
  const fdGroups = fdOnlyTxns.reduce((acc, txn) => {
    const name = txn.account_name || 'Other Accounts';
    if (!acc[name]) acc[name] = [];
    acc[name].push(txn);
    return acc;
  }, {});

  Object.entries(fdGroups).forEach(([name, txns]) => {
    const holdings = calculateFDHoldings(txns);
    if (!fdAccountTotals.has(name)) {
      fdAccountTotals.set(name, { marketValue: 0, invested: 0, dayChange: 0 });
    }
    const stats = fdAccountTotals.get(name);
    stats.marketValue += holdings.total;
    stats.invested += holdings.invested;
  });

  const totalFDMarketValue = Array.from(fdAccountTotals.values()).reduce((sum, s) => sum + s.marketValue, 0);
  const totalFDInvested = Array.from(fdAccountTotals.values()).reduce((sum, s) => sum + s.invested, 0);

  return {
    bank: {
      overall: { total: totalBankMarketValue, marketValue: totalBankMarketValue, invested: totalBankMarketValue },
      accounts: Object.fromEntries(bankAccountTotals)
    },
    ppf: {
      overall: calculatePPFHoldings(ppfOnlyTxns),
      accounts: Object.fromEntries(ppfAccountTotals)
    },
    epf: {
      overall: epfOverall,
      accounts: {} // EPF has no account breakdown
    },
    fd: {
      overall: { 
        total: totalFDMarketValue,
        invested: totalFDInvested,
        marketValue: totalFDMarketValue
      },
      accounts: Object.fromEntries(fdAccountTotals)
    }
  };
}

export default { getFixedAssetTotals };
