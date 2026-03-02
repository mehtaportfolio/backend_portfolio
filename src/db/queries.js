/**
 * Reusable Supabase Query Helpers
 * Handles paginated and bulk fetches with error handling
 */

/**
 * Fetch all rows from a table with pagination
 * @param {SupabaseClient} supabase - Supabase client instance
 * @param {string} tableName - Table name
 * @param {object} options - Options: { select, filter, order, limit }
 * @returns {Promise<{data: Array, error: Error|null}>}
 */
export async function fetchAllRows(supabase, tableName, options = {}) {
  try {
    const {
      select = '*',
      filter,
      filters,
      order,
      limit,
      chunkSize = 1000,
    } = options;

    const effectiveChunkSize = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : 1000;
    const maxRows = Number.isInteger(limit) && limit > 0 ? limit : Infinity;
    const results = [];
    let from = 0;

    const buildQuery = () => {
      let query = supabase.from(tableName).select(select);

      if (filter) {
        Object.entries(filter).forEach(([key, value]) => {
          query = query.eq(key, value);
        });
      }

      if (Array.isArray(filters)) {
        filters.forEach((applyFilter) => {
          if (typeof applyFilter === 'function') {
            const maybeQuery = applyFilter(query);
            if (maybeQuery && typeof maybeQuery.select === 'function') {
              query = maybeQuery;
            }
          }
        });
      }

      if (order) {
        query = query.order(order.column, { ascending: order.ascending ?? true });
      }

      return query;
    };

    while (results.length < maxRows) {
      const remaining = maxRows === Infinity ? effectiveChunkSize : Math.min(effectiveChunkSize, maxRows - results.length);
      if (remaining <= 0) break;

      const query = buildQuery().range(from, from + remaining - 1);
      const { data, error } = await query;

      if (error) {
        console.error(`Query error for ${tableName}:`, error);
        return { data: [], error };
      }

      if (!data?.length) {
        break;
      }

      results.push(...data);

      if (data.length < remaining) {
        break;
      }

      from += remaining;
    }

    return { data: results, error: null };
  } catch (error) {
    console.error(`Fetch error for ${tableName}:`, error);
    return { data: [], error };
  }
}

/**
 * Batch fetch multiple tables in parallel
 * @param {SupabaseClient} supabase - Supabase client
 * @param {object} queries - { tableName: options }
 * @returns {Promise<object>} - { tableName: { data, error } }
 */
export async function batchFetchTables(supabase, queries) {
  const results = {};
  const promises = [];

  Object.entries(queries).forEach(([tableName, options]) => {
    promises.push(
      fetchAllRows(supabase, tableName, options).then((result) => {
        results[tableName] = result;
      })
    );
  });

  await Promise.all(promises);
  return results;
}

/**
 * Fetch specific user's data
 * @param {SupabaseClient} supabase - Supabase client
 * @param {string} userId - User ID
 * @param {string} priceSource - Price source ('stock_master' or 'stock_mapping')
 * @returns {Promise<object>} - All user's data tables
 */
export async function fetchUserAllData(supabase, userId, priceSource = 'stock_master') {
  if (!userId) {
    throw new Error('User ID is required');
  }

  // Determine price table based on priceSource
  const priceTable = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';

  // Support array of userIds
  const userIdArray = Array.isArray(userId) ? userId : [userId];
  const filterFn = (q) => {
    if (userId === 'all') return q;
    return q.in('account_name', userIdArray);
  };

  const queries = {
    stock_transactions: {
      select: 'stock_name, quantity, buy_price, sell_date, account_type, buy_date, account_name, equity_type',
      filters: [filterFn]
    },
    [priceTable]: {
      select: 'stock_name, cmp, lcp',
    },
    mf_transactions: {
      select: 'fund_short_name, account_name, units, transaction_type, nav, date',
      filters: [filterFn]
    },
    fund_master: {
      select: 'fund_short_name, cmp, lcp',
    },
    bank_transactions: {
      select: 'account_name, bank_name, account_type, txn_date, amount',
      filters: [filterFn]
    },
    epf_transactions: {
      select: 'employee_share, employer_share, pension_share, invest_type, contribution_date',
    },
    ppf_transactions: {
      select: 'account_name, txn_date, amount, transaction_type, account_type',
      order: { column: 'txn_date', ascending: true },
      filters: [filterFn]
    },
    nps_transactions: {
      select: 'scheme_name, account_name, units, transaction_type, nav, date, created_at, fund_name',
      filters: [filterFn]
    },
    nps_pension_fund_master: {
      select: 'scheme_name, cmp, lcp',
    },
    equity_charges: {
      select: 'account_name, year, fy, other_charges, dp_charges',
      filters: [filterFn]
    },
    other_transactions: {
      select: 'account_name, transaction_type, amount',
    },
  };

  // If using stock_mapping, also fetch stock_master for fallback
  if (priceTable === 'stock_mapping') {
    queries.stock_master = {
      select: 'stock_name, cmp, lcp',
    };
  }

  const result = await batchFetchTables(supabase, queries);

  // Merge stock_master as fallback for stock_mapping
  if (priceTable === 'stock_mapping' && result.stock_mapping?.data && result.stock_master?.data) {
    const mappingMap = new Map();
    const masterMap = new Map();

    (result.stock_mapping.data || []).forEach(stock => {
      const normalizedKey = String(stock.stock_name).trim().toUpperCase();
      mappingMap.set(normalizedKey, stock);
    });

    (result.stock_master.data || []).forEach(stock => {
      const normalizedKey = String(stock.stock_name).trim().toUpperCase();
      masterMap.set(normalizedKey, stock);
    });

    const mergedData = [];
    const processedKeys = new Set();

    mappingMap.forEach((stock, normalizedKey) => {
      const cmp = stock.cmp && stock.cmp !== 0 ? stock.cmp : masterMap.get(normalizedKey)?.cmp;
      const lcp = stock.lcp && stock.lcp !== 0 ? stock.lcp : masterMap.get(normalizedKey)?.lcp;

      mergedData.push({
        stock_name: stock.stock_name,
        cmp: cmp || 0,
        lcp: lcp || 0,
      });
      processedKeys.add(normalizedKey);
    });

    masterMap.forEach((stock, normalizedKey) => {
      if (!processedKeys.has(normalizedKey)) {
        mergedData.push({
          stock_name: stock.stock_name,
          cmp: stock.cmp || 0,
          lcp: stock.lcp || 0,
        });
      }
    });

    result.stock_mapping = { data: mergedData, error: null };
  }

  return result;
}

export default { fetchAllRows, batchFetchTables, fetchUserAllData };