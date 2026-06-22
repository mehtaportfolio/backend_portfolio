// backend/src/services/dividendService.js
import { supabase } from '../db/supabaseClient.js';
import { sendPushNotification } from './notificationService.js';
import { fetchAllRows, insertRows, updateRows } from '../db/queries.js';

/**
 * Sync dividends from corporate_actions to dividend_events
 * @returns {Promise<number>} Number of new records synced
 */
export async function syncDividendsFromCorporateActions() {
  // 1. Fetch corporate actions for Dividends
  const { data: actions, error: actionsError } = await fetchAllRows(supabase, 'corporate_actions', {
    filters: [(q) => q.in('action_type', ['Dividend', 'DIVIDEND'])]
  });
  
  if (actionsError) throw actionsError;
  if (!actions || actions.length === 0) return 0;

  // Filter actions to prefer NSE over Yahoo for the same event
  const actionMap = new Map();
  actions.forEach((action) => {
    const key = `${action.symbol}|${action.ex_date}|${action.dividend_amount}`;
    const existing = actionMap.get(key);
    if (!existing || (action.source === 'NSE' && existing.source !== 'NSE')) {
      actionMap.set(key, action);
    }
  });
  const uniqueActions = Array.from(actionMap.values());

  // 2. Fetch existing dividend_events to avoid duplicates
  const { data: existingEvents, error: existingError } = await fetchAllRows(supabase, 'dividend_events', {
    select: 'symbol, ex_date, dividend_amount'
  });
    
  if (existingError) throw existingError;

  const existingSet = new Set(
    (existingEvents || []).map(e => `${e.symbol}|${e.ex_date}|${e.dividend_amount}`)
  );

  const newRecords = [];
  for (const action of uniqueActions) {
    const key = `${action.symbol}|${action.ex_date}|${action.dividend_amount}`;
    if (existingSet.has(key)) continue;

    newRecords.push({
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
      status: 'active'
    });
  }

  if (newRecords.length > 0) {
    const { error: insertError } = await insertRows(supabase, 'dividend_events', newRecords);
    if (insertError) throw insertError;
    return newRecords.length;
  }
  return 0;
}

/**
 * Apply active dividend events to account_cashflows
 * @returns {Promise<number>} Number of cashflows generated
 */
export async function applyActiveDividends() {
  // 1. Fetch relevant stock transactions (open OR sold after ex_date)
  const { data: transactions, error: txError } = await fetchAllRows(supabase, 'stock_transactions', {
    select: 'stock_name, account_name, quantity, buy_date, sell_date'
  });
    
  if (txError) throw txError;

  // 2. Fetch active dividend events
  const { data: activeEvents, error: evError } = await fetchAllRows(supabase, 'dividend_events', {
    filters: [(q) => q.ilike('status', 'active')]
  });
    
  if (evError) throw evError;
  if (!activeEvents || activeEvents.length === 0) return 0;

  // 3. Fetch existing dividend cashflows to avoid duplicates
  const { data: existingCashflows, error: cfError } = await fetchAllRows(supabase, 'account_cashflows', {
    select: 'stock_name, account_name, date, amount',
    filters: [(q) => q.eq('transaction_type', 'dividend')]
  });
    
  if (cfError) throw cfError;

  const existingCFSet = new Set(
    (existingCashflows || []).map(cf => `${cf.stock_name}|${cf.account_name}|${cf.date}|${cf.amount}`)
  );

  // 4. Fetch stock mapping
  const { data: mappingData } = await fetchAllRows(supabase, 'stock_mapping', {
    select: 'stock_name, symbol_gs, symbol_ao'
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
    const [stockName, accountName] = groupKey.split('|');
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
          transaction_type: 'dividend',
          amount: amount,
          date: ev.ex_date,
          stock_name: stockName,
          notes: 'Auto-generated from dividend events (Backend)'
        });
        existingCFSet.add(key);
        appliedEventIds.add(ev.id);
      } else {
        appliedEventIds.add(ev.id);
      }
    }
  }

  if (newCashflows.length > 0) {
    const { error: insertError } = await insertRows(supabase, 'account_cashflows', newCashflows);
    if (insertError) throw insertError;
    
    // Mark processed events as inactive
    const idsToInactivate = Array.from(appliedEventIds);
    if (idsToInactivate.length > 0) {
      const { error: updateError } = await updateRows(supabase, 'dividend_events', 
        { status: 'inactive' }, 
        (q) => q.in('id', idsToInactivate)
      );
      if (updateError) throw updateError;
    }
    return newCashflows.length;
  }
  return 0;
}

/**
 * Run full dividend automation: sync + apply
 * @returns {Promise<object>} Result summary
 */
export async function runDividendAutomation() {
  const syncedCount = await syncDividendsFromCorporateActions();
  const appliedCount = await applyActiveDividends();
  
  const result = { syncedCount, appliedCount };
  
  if (syncedCount > 0 || appliedCount > 0) {
    const message = `Dividend updated: ${syncedCount} new events synced, ${appliedCount} cashflows generated.`;
    await sendPushNotification({
      title: 'Dividend Updated',
      body: message,
      icon: '/mainphoto.png',
      badge: '/logo192.png',
      data: { url: '/' }
    });
    result.message = message;
  } else {
    result.message = 'No new dividend found.';
  }
  
  return result;
}
