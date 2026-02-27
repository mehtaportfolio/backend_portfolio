/**
 * Initialize stock_mapping table
 * This script creates the stock_mapping table and seeds it with initial data from stock_master
 */

import { supabase } from './supabaseClient.js';

export async function initializeStockMapping() {
  try {
    // Try to fetch from stock_mapping to check if table exists
    const { data, error } = await supabase
      .from('stock_mapping')
      .select('stock_name')
      .limit(1);
    
    if (!error) {
      return true;
    }
    
    return false;
  } catch (err) {
    console.error('[Init] Error checking stock_mapping table:', err);
    return false;
  }
}

/**
 * Seed stock_mapping with initial data from stock_master
 */
export async function seedStockMappingFromMaster() {
  try {
    const { data: masterStocks, error: fetchError } = await supabase
      .from('stock_master')
      .select('stock_name, cmp, lcp, category, sector');
    
    if (fetchError) {
      console.error('[Seed] Error fetching from stock_master:', fetchError);
      return false;
    }
    
    if (!masterStocks || masterStocks.length === 0) {
      return false;
    }
    
    // Upsert into stock_mapping
    const { error: upsertError, data: upserted } = await supabase
      .from('stock_mapping')
      .upsert(
        masterStocks.map(stock => ({
          stock_name: stock.stock_name,
          cmp: stock.cmp,
          lcp: stock.lcp,
          category: stock.category,
          sector: stock.sector,
        })),
        { onConflict: 'stock_name' }
      );
    
    if (upsertError) {
      console.error('[Seed] Error upserting into stock_mapping:', upsertError);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('[Seed] Error seeding stock_mapping:', err);
    return false;
  }
}
