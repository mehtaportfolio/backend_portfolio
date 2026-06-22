import { supabase } from '../db/supabaseClient.js';

/**
 * Search schemes by fund name.
 * Falls back to returning an empty array on error so the caller
 * can decide how to notify the user.
 *
 * @param {string} searchTerm - Search string entered by the user
 * @param {number} [limit=25] - Maximum results to fetch
 * @returns {Promise<{ data: Array, error: any }>} Supabase response shape
 */
export async function searchSchemes(searchTerm, limit = 25) {
  if (!searchTerm?.trim()) {
    return { data: [], error: null };
  }

  try {
    const { fetchAllRows } = await import('../db/queries.js');
    const { data, error } = await fetchAllRows(supabase, 'scheme_list', {
      select: 'fund_full_name, scheme_code',
      filters: [(q) => q.ilike('fund_full_name', `%${searchTerm.trim()}%`)],
      order: { column: 'fund_full_name', ascending: true },
      limit
    });

    if (error) {
      console.error('Supabase scheme_list search error:', error);
      return { data: [], error };
    }

    return { data: data ?? [], error: null };
  } catch (err) {
    console.error('Unexpected error searching scheme_list:', err);
    return { data: [], error: err };
  }
}