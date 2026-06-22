/**
 * Reusable Supabase Query Helpers
 * Handles paginated and bulk fetches with error handling
 */

/**
 * Helper to run a Supabase query with retry logic
 * @param {Function} queryFn - Function that returns a Supabase query
 * @param {string} label - Label for logging
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise<{data: any, error: Error|null}>}
 */
async function runWithRetry(queryFn, label = 'Query', maxRetries = 3) {
  let retries = 0;
  while (retries <= maxRetries) {
    try {
      const result = await queryFn();
      const { data, error } = result;

      // If we have a fetch error (Intermittent network issue), retry
      if (error && (error.message?.includes('fetch failed') || error.code === 'ETIMEDOUT')) {
        throw error; // Trigger catch for retry
      }
      return { data, error }; // Success or non-fetch error
    } catch (err) {
      retries++;
      if (retries > maxRetries) {
        return { data: null, error: err };
      }
      console.warn(`Retry ${retries}/${maxRetries} for ${label} due to: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Exponential backoff
    }
  }
}

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

      const { data, error } = await runWithRetry(
        () => buildQuery().range(from, from + remaining - 1),
        `fetchAllRows:${tableName}`
      );

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
 * Insert rows into a table with retry logic
 * @param {SupabaseClient} supabase 
 * @param {string} tableName 
 * @param {Array|object} data 
 * @returns {Promise<{data: any, error: Error|null}>}
 */
export async function insertRows(supabase, tableName, data) {
  return runWithRetry(
    () => supabase.from(tableName).insert(Array.isArray(data) ? data : [data]).select(),
    `insertRows:${tableName}`
  );
}

/**
 * Update rows in a table with retry logic
 * @param {SupabaseClient} supabase 
 * @param {string} tableName 
 * @param {object} updates 
 * @param {object} filter - { column: value } or function
 * @returns {Promise<{data: any, error: Error|null}>}
 */
export async function updateRows(supabase, tableName, updates, filter) {
  return runWithRetry(
    () => {
      let query = supabase.from(tableName).update(updates);
      if (typeof filter === 'function') {
        query = filter(query);
      } else if (filter && typeof filter === 'object') {
        Object.entries(filter).forEach(([key, value]) => {
          query = query.eq(key, value);
        });
      }
      return query.select();
    },
    `updateRows:${tableName}`
  );
}

/**
 * Delete rows from a table with retry logic
 * @param {SupabaseClient} supabase 
 * @param {string} tableName 
 * @param {object} filter - { column: value } or function
 * @returns {Promise<{data: any, error: Error|null}>}
 */
export async function deleteRows(supabase, tableName, filter) {
  return runWithRetry(
    () => {
      let query = supabase.from(tableName).delete();
      if (typeof filter === 'function') {
        query = filter(query);
      } else if (filter && typeof filter === 'object') {
        Object.entries(filter).forEach(([key, value]) => {
          query = query.eq(key, value);
        });
      }
      return query.select();
    },
    `deleteRows:${tableName}`
  );
}

/**
 * Upsert rows into a table with retry logic
 * @param {SupabaseClient} supabase 
 * @param {string} tableName 
 * @param {Array|object} data 
 * @param {object} options - Upsert options (e.g., { onConflict: 'column' })
 * @returns {Promise<{data: any, error: Error|null}>}
 */
export async function upsertRows(supabase, tableName, data, options = {}) {
  return runWithRetry(
    () => supabase.from(tableName).upsert(Array.isArray(data) ? data : [data], options).select(),
    `upsertRows:${tableName}`
  );
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
 * Resolve Account Names from user_master
 * @param {SupabaseClient} supabase - Supabase client
 * @returns {Promise<Array<string>>} - Array of account names
 */
export async function getResolvedAccountNames(supabase) {
  // Single-user mode: return all account names from user_master
  const { data: userMaster } = await fetchAllRows(supabase, 'user_master', {
    select: 'account_name'
  });

  if (userMaster && userMaster.length > 0) {
    return [...new Set(userMaster.map(u => u.account_name).filter(Boolean))];
  }

  return [];
}

/**
 * Fetch all user's data
 * @param {SupabaseClient} supabase - Supabase client
 * @param {string} priceSource - Price source ('stock_master' or 'stock_mapping')
 * @returns {Promise<object>} - All data tables
 */
export async function fetchUserAllData(supabase, priceSource = 'stock_master') {
  // Determine price table based on priceSource
  const priceTable = priceSource === 'stock_mapping' ? 'stock_mapping' : 'stock_master';

  const queries = {
    stock_transactions: {
      select: 'stock_name, quantity, buy_price, sell_date, account_type, buy_date, account_name, equity_type',
    },
    [priceTable]: {
      select: priceTable === 'stock_mapping' ? 'stock_name, cmp, lcp, symbol_ao' : 'stock_name, cmp, lcp',
    },
    mf_transactions: {
      select: 'fund_short_name, account_name, units, transaction_type, nav, date',
    },
    fund_master: {
      select: 'fund_short_name, cmp, lcp',
    },
    bank_transactions: {
      select: 'account_name, bank_name, account_type, txn_date, amount',
    },
    epf_transactions: {
      select: 'employee_share, employer_share, pension_share, invest_type, contribution_date, company_name',
    },
    ppf_transactions: {
      select: 'account_name, txn_date, amount, transaction_type, account_type',
      order: { column: 'txn_date', ascending: true },
    },
    nps_transactions: {
      select: 'scheme_name, account_name, units, transaction_type, nav, date, created_at, fund_name',
    },
    nps_pension_fund_master: {
      select: 'scheme_name, cmp, lcp',
    },
    equity_charges: {
      select: 'account_name, year, fy, other_charges, dp_charges',
    },
    other_transactions: {
      select: 'account_name, transaction_type, amount',
    },
  };

  if (priceSource !== 'stock_master') {
    queries.fund_master_backend = {
      select: 'fund_short_name, nav, last_sync_at',
      order: { column: 'last_sync_at', ascending: false },
    };
  }

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

export default {
  fetchAllRows,
  batchFetchTables,
  fetchUserAllData,
  getResolvedAccountNames,
  insertRows,
  updateRows,
  deleteRows,
  upsertRows,
};
