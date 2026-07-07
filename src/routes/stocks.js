/**
 * Stock Routes
 * GET /api/stock/open - Open holdings
 * GET /api/stock/closed - Closed holdings
 * GET /api/stock/etf - ETF holdings
 * GET /api/stock/portfolio - Portfolio summary
 */

import express from 'express';
import authMiddleware from '../middleware/auth.js';
import cache, { cacheMiddleware } from '../middleware/cache.js';
import {
  getOpenStockData,
  getClosedStockData,
  getETFData,
  getPortfolioData,
  bulkUpdateAccountType,
  addStockTransaction,
  addBulkStockTransactions,
  updateStockTransaction,
  deleteStockTransaction,
  sellStockTransaction,
  getStockAccountNames,
  getStockMasterData,
  getStockMasterDistinctValues,
  addStockMasterRecord,
  updateStockMasterRecord,
  renameStockRecord,
  getEquityCharges,
  addEquityCharge,
  updateEquityCharge,
  deleteEquityCharge,
  getRecentSearches,
  addRecentSearch,
  clearRecentSearches,
  getIncompleteStockMaster,
  getIncompleteStockMapping,
  getAllBonusSplits,
  syncCorporateActions,
  addBonusSplit,
  updateBonusSplit,
  deleteBonusSplit,
  applyBonusSplitAction,
  revertBonusSplitAction,
  applyBulkBonusSplits,
  revertBulkBonusSplits,
  updateBonusSplitStatusBulk,
  getAllStockMappings,
  addStockMapping,
  updateStockMapping,
  deleteStockMapping,
  getStockSymbols,
  getWatchlist,
  getAllWatchlists,
  addWatchlist,
  updateWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getCashflowData,
  addCashflow,
  updateCashflow,
  deleteCashflow,
  applyDividendEvents,
  syncDividendEvents,
  getDividendEvents,
  getMarketIndices,
  searchStockMaster,
  getEquityPositions,
  deleteEquityPositions,
  getStockTransactionsByDates,
  getZerodhaTokenStatus,
  getStockCMP,
} from '../services/stockService.js';
import { 
  fetchAndAggregateTrades as zerodhaSync,
  automateZerodhaLogin
} from '../services/zerodhaService.js';
import { fetchTodayBuyTrades as angelOneSync } from '../services/angelOneService.js';
import { supabase } from '../db/supabaseClient.js';
import { insertRows } from '../db/queries.js';

const router = express.Router();

/**
 * GET /api/stock/open
 * Fetch open stock holdings with XIRR
 * Query params: priceSource (stock_master|stock_mapping)
 */
router.get('/open', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const priceSource = req.query.priceSource || 'stock_master';
    const data = await getOpenStockData(supabase, priceSource);
    res.json(data);
  } catch (error) {
    console.error('[Stock API] Error fetching open stock data:', error);
    res
      .status(500)
      .json({ error: error.message || 'Failed to fetch open stock data' });
  }
});

/**
 * GET /api/stock/cmp
 * Fetch CMP for a specific stock
 * Query params: stockName, priceSource
 */
router.get('/cmp', authMiddleware, async (req, res) => {
  try {
    const { stockName, priceSource } = req.query;
    if (!stockName) {
      return res.status(400).json({ error: 'stockName is required' });
    }

    const cmp = await getStockCMP(supabase, stockName, priceSource);
    res.json({ cmp });
  } catch (error) {
    console.error('[Stock API] Error fetching CMP:', error);
    res.status(500).json({ error: 'Failed to fetch CMP' });
  }
});

/**
 * GET /api/stock/closed
 * Fetch closed stock holdings
 * Query params: priceSource (stock_master|stock_mapping)
 */
router.get('/closed', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const priceSource = req.query.priceSource || 'stock_master';
    const data = await getClosedStockData(supabase, priceSource);
    res.json(data);
  } catch (error) {
    console.error('[Stock API] Error fetching closed stock data:', error);
    res
      .status(500)
      .json({ error: error.message || 'Failed to fetch closed stock data' });
  }
});

/**
 * GET /api/stock/etf
 * Fetch ETF holdings
 * Query params: priceSource (stock_master|stock_mapping)
 */
router.get('/etf', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const priceSource = req.query.priceSource || 'stock_master';
    const data = await getETFData(supabase, priceSource);
    res.json(data);
  } catch (error) {
    console.error('[Stock API] Error fetching ETF data:', error);
    res
      .status(500)
      .json({ error: error.message || 'Failed to fetch ETF data' });
  }
});

/**
 * GET /api/stock/portfolio
 * Fetch portfolio summary with account-wise breakdown
 * Query params: priceSource (stock_master|stock_mapping)
 */
router.get('/portfolio', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const priceSource = req.query.priceSource || 'stock_master';
    const data = await getPortfolioData(supabase, priceSource);
    res.json(data);
  } catch (error) {
    console.error('[Stock API] Error fetching portfolio data:', error);
    res
      .status(500)
      .json({ error: error.message || 'Failed to fetch portfolio data' });
  }
});

/**
 * POST /api/stock/invalidate-cache
 * Invalidate all stock-related cache
 */
router.post('/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    
    const stockKeys = allKeys.filter(key => 
      key.includes('/open:') || 
      key.includes('/closed:') || 
      key.includes('/etf:') || 
      key.includes('/portfolio:')
    );
    
    stockKeys.forEach(key => {
      cache.delete(key);
    });
    
    res.json({ 
      success: true, 
      message: `Cleared ${stockKeys.length} cache entries`,
      clearedCount: stockKeys.length
    });
  } catch (error) {
    console.error('[Stock Cache] Error invalidating cache:', error);
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

/**
 * POST /api/stock/bulk-update-account
 * Bulk update account type for a stock
 */
router.post('/bulk-update-account', authMiddleware, async (req, res) => {
  try {
    const { stockName, accountType } = req.body;

    if (!stockName || !accountType) {
      return res.status(400).json({ error: 'Stock name and account type are required' });
    }

    const result = await bulkUpdateAccountType(supabase, stockName, accountType);
    
    // Invalidate cache after update
    const allKeys = cache.stats().keys;
    const stockKeys = allKeys.filter(key => 
      key.includes('/open:') || 
      key.includes('/closed:') || 
      key.includes('/etf:') || 
      key.includes('/portfolio:') ||
      key.includes('/free-stocks:')
    );
    stockKeys.forEach(key => cache.delete(key));

    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error in bulk update:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk update account type' });
  }
});

/**
 * GET /api/stock/zerodha-status
 * Get Zerodha token status
 */
router.get('/zerodha-status', authMiddleware, async (req, res) => {
  try {
    const result = await getZerodhaTokenStatus(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching Zerodha status:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch Zerodha status' });
  }
});

/**
 * GET /api/stock/zerodha-sync
 * Sync Zerodha trades
 */
router.get('/zerodha-sync', authMiddleware, zerodhaSync);

/**
 * GET /api/stock/zerodha-automate
 * Automate Zerodha login
 */
router.get('/zerodha-automate', authMiddleware, automateZerodhaLogin);

/**
 * GET /api/stock/angel-one-health
 * Check Angel One health
 */
router.get('/angel-one-health', authMiddleware, (req, res) => {
  res.json({
    status: 'success',
    message: 'Angel One internal service is running',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/stock/angel-one-sync
 * Sync Angel One trades
 */
router.get('/angel-one-sync', authMiddleware, async (req, res) => {
  try {
    const result = await angelOneSync();
    
    if (!result) {
      return res.status(500).json({ 
        status: 'error', 
        message: 'Angel One sync returned no response'
      });
    }

    if (!result.success) {
      return res.status(500).json({ 
        status: 'error', 
        message: result.message || 'Failed to sync Angel One trades' 
      });
    }

    const { orders = [], formatted = [], inserted = 0, updated = 0, today = null } = result;
    
    if (!Array.isArray(formatted) || formatted.length === 0) {
      const firstOrder = Array.isArray(orders) && orders.length > 0 ? orders[0] : null;
      const firstOrderStr = firstOrder ? 
        `[Prod: ${firstOrder.producttype || firstOrder.product}, Type: ${firstOrder.transactiontype}, Symbol: ${firstOrder.tradingsymbol || firstOrder.symbol}]` : 
        "None";

      return res.json({ 
        status: 'success',
        message: `No CNC BUY trades found for today (${today}) in PSM. Total orders found: ${Array.isArray(orders) ? orders.length : 0}. First order: ${firstOrderStr}`,
        data: []
      });
    }

    res.json({ 
      status: 'success', 
      message: `✅ Angel One: Processed ${inserted} new and ${updated} updated trades`,
      data: formatted
    });
  } catch (error) {
    console.error('[Stock API] Angel One sync error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/stock/accounts
 * Get unique account names from stock transactions
 */
router.get('/accounts', authMiddleware, async (req, res) => {
  try {
    const { type } = req.query;
    const result = await getStockAccountNames(supabase, type);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching accounts:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch accounts' });
  }
});

/**
 * Helper to invalidate stock cache
 */
const invalidateStockCache = () => {
  const allKeys = cache.stats().keys;
  const stockKeys = allKeys.filter(key => 
    key.includes('/open:') || 
    key.includes('/closed:') || 
    key.includes('/etf:') || 
    key.includes('/portfolio:') ||
    key.includes('/free-stocks:')
  );
  stockKeys.forEach(key => cache.delete(key));
};

/**
 * POST /api/stock/transaction
 * Add a new stock transaction
 */
router.post('/transaction', authMiddleware, async (req, res) => {
  try {
    const transaction = req.body;
    const result = await addStockTransaction(supabase, transaction);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to add transaction' });
  }
});

/**
 * PUT /api/stock/transaction/:id
 * Update a stock transaction
 */
router.put('/transaction/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const result = await updateStockTransaction(supabase, id, updates);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to update transaction' });
  }
});

/**
 * DELETE /api/stock/transaction/:id
 * Delete a stock transaction
 */
router.delete('/transaction/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await deleteStockTransaction(supabase, id);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to delete transaction' });
  }
});

/**
 * POST /api/stock/transaction/sell/:id
 * Sell a stock transaction
 */
router.post('/transaction/sell/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const sellDetails = req.body;

    const result = await sellStockTransaction(supabase, id, sellDetails);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error selling transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to sell transaction' });
  }
});

/**
 * POST /api/stock/transaction/bulk
 * Bulk add stock transactions
 */
router.post('/transaction/bulk', authMiddleware, async (req, res) => {
  try {
    const { transactions } = req.body;
    const result = await addBulkStockTransactions(supabase, transactions);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error bulk adding transactions:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk add transactions' });
  }
});

/**
 * GET /api/stock/master
 * Get stock master data
 */
router.get('/master', authMiddleware, async (req, res) => {
  try {
    const result = await getStockMasterData(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching stock master:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch stock master' });
  }
});

/**
 * GET /api/stock/master/distinct/:field
 * Get distinct values for a stock master field
 */
router.get('/master/distinct/:field', authMiddleware, async (req, res) => {
  try {
    const { field } = req.params;
    const result = await getStockMasterDistinctValues(supabase, field);
    res.json(result);
  } catch (error) {
    console.error(`[Stock API] Error fetching distinct values for ${req.params.field}:`, error);
    res.status(500).json({ error: error.message || 'Failed to fetch distinct values' });
  }
});

/**
 * POST /api/stock/master
 * Add stock master record
 */
router.post('/master', authMiddleware, async (req, res) => {
  try {
    const stockData = req.body;
    const result = await addStockMasterRecord(supabase, stockData);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding stock master:', error);
    res.status(500).json({ error: error.message || 'Failed to add stock master' });
  }
});

/**
 * PUT /api/stock/master/:symbol
 * Update stock master record
 */
router.put('/master/:symbol', authMiddleware, async (req, res) => {
  try {
    const { symbol } = req.params;
    const stockData = req.body;
    const result = await updateStockMasterRecord(supabase, symbol, stockData);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating stock master:', error);
    res.status(500).json({ error: error.message || 'Failed to update stock master' });
  }
});

/**
 * POST /api/stock/master/rename
 * Rename stock record
 */
router.post('/master/rename', authMiddleware, async (req, res) => {
  try {
    const { oldSymbol, ...newDetails } = req.body;
    const result = await renameStockRecord(supabase, oldSymbol, newDetails);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error renaming stock:', error);
    res.status(500).json({ error: error.message || 'Failed to rename stock' });
  }
});

/**
 * GET /api/stock/charges
 * Get equity charges
 */
router.get('/charges', authMiddleware, async (req, res) => {
  try {
    const result = await getEquityCharges(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching charges:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch charges' });
  }
});

/**
 * POST /api/stock/charges
 * Add equity charge
 */
router.post('/charges', authMiddleware, async (req, res) => {
  try {
    const chargeData = req.body;
    const result = await addEquityCharge(supabase, chargeData);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding charge:', error);
    res.status(500).json({ error: error.message || 'Failed to add charge' });
  }
});

/**
 * PUT /api/stock/charges/:id
 * Update equity charge
 */
router.put('/charges/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const chargeData = req.body;
    const result = await updateEquityCharge(supabase, id, chargeData);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating charge:', error);
    res.status(500).json({ error: error.message || 'Failed to update charge' });
  }
});

/**
 * DELETE /api/stock/charges/:id
 * Delete equity charge
 */
router.delete('/charges/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteEquityCharge(supabase, id);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting charge:', error);
    res.status(500).json({ error: error.message || 'Failed to delete charge' });
  }
});

/**
 * GET /api/stock/watchlist
 * Get watchlist
 */
router.get('/watchlist', authMiddleware, async (req, res) => {
  try {
    const result = await getWatchlist(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching watchlist:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch watchlist' });
  }
});

/**
 * POST /api/stock/watchlist
 * Add to watchlist
 */
router.post('/watchlist', authMiddleware, async (req, res) => {
  try {
    const stockData = req.body;
    const result = await addToWatchlist(supabase, stockData);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding to watchlist:', error);
    res.status(500).json({ error: error.message || 'Failed to add to watchlist' });
  }
});

/**
 * DELETE /api/stock/watchlist/:id
 * Remove from watchlist
 */
router.delete('/watchlist/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await removeFromWatchlist(supabase, id);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error removing from watchlist:', error);
    res.status(500).json({ error: error.message || 'Failed to remove from watchlist' });
  }
});

/**
 * Recent Search Routes
 */
router.get('/recent-searches', authMiddleware, async (req, res) => {
  try {
    const result = await getRecentSearches(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching recent searches:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch recent searches' });
  }
});

router.post('/recent-searches', authMiddleware, async (req, res) => {
  try {
    const { stockName } = req.body;
    const result = await addRecentSearch(supabase, stockName);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding recent search:', error);
    res.status(500).json({ error: error.message || 'Failed to add recent search' });
  }
});

router.delete('/recent-searches', authMiddleware, async (req, res) => {
  try {
    const result = await clearRecentSearches(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error clearing recent searches:', error);
    res.status(500).json({ error: error.message || 'Failed to clear recent searches' });
  }
});

/**
 * Cashflow Routes
 */
router.get('/cashflow', authMiddleware, async (req, res) => {
  try {
    const { transaction_type, account_name, stock_name, startDate, endDate } = req.query;
    const result = await getCashflowData(supabase, { transaction_type, account_name, stock_name, startDate, endDate });
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching cashflow:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch cashflow' });
  }
});

router.post('/cashflow', authMiddleware, async (req, res) => {
  try {
    const result = await addCashflow(supabase, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding cashflow:', error);
    res.status(500).json({ error: error.message || 'Failed to add cashflow' });
  }
});

router.put('/cashflow/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await updateCashflow(supabase, id, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating cashflow:', error);
    res.status(500).json({ error: error.message || 'Failed to update cashflow' });
  }
});

router.delete('/cashflow/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteCashflow(supabase, id);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting cashflow:', error);
    res.status(500).json({ error: error.message || 'Failed to delete cashflow' });
  }
});

/**
 * Dividend Event Routes
 */
router.get('/dividend-events', authMiddleware, async (req, res) => {
  try {
    const result = await getDividendEvents(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching dividend events:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch dividend events' });
  }
});

router.post('/dividend-events', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await insertRows(supabase, 'dividend_events', req.body);
    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('[Stock API] Error adding dividend event:', error);
    res.status(500).json({ error: error.message || 'Failed to add dividend event' });
  }
});

router.post('/dividend-events/sync', authMiddleware, async (req, res) => {
  try {
    const result = await syncDividendEvents(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error syncing dividend events:', error);
    res.status(500).json({ error: error.message || 'Failed to sync dividend events' });
  }
});

router.put('/dividend-events/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await updateDividendEvent(supabase, id, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating dividend event:', error);
    res.status(500).json({ error: error.message || 'Failed to update dividend event' });
  }
});

router.delete('/dividend-events/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteDividendEvent(supabase, id);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting dividend event:', error);
    res.status(500).json({ error: error.message || 'Failed to delete dividend event' });
  }
});

router.post('/dividend-events/apply', authMiddleware, async (req, res) => {
  try {
    const result = await applyDividendEvents(supabase);
    
    // Invalidate stock cache after applying dividends as it affects portfolio returns
    invalidateStockCache();
    
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error applying dividend events:', error);
    res.status(500).json({ error: error.message || 'Failed to apply dividend events' });
  }
});

/**
 * Market Indices
 */
router.get('/indices', authMiddleware, async (req, res) => {
  try {
    const { source = 'market_indices' } = req.query;
    const result = await getMarketIndices(supabase, source);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching market indices:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch market indices' });
  }
});

/**
 * Stock Master Search
 */
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q, limit } = req.query;
    const result = await searchStockMaster(supabase, q, limit);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error searching stock master:', error);
    res.status(500).json({ error: error.message || 'Failed to search stock master' });
  }
});

/**
 * Bonus/Split Routes
 */
router.get('/bonus-split', authMiddleware, async (req, res) => {
  try {
    const result = await getAllBonusSplits(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching bonus splits:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch bonus splits' });
  }
});

router.post('/bonus-split/sync', authMiddleware, async (req, res) => {
  try {
    const result = await syncCorporateActions(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error syncing corporate actions:', error);
    res.status(500).json({ error: error.message || 'Failed to sync corporate actions' });
  }
});

router.post('/bonus-split', authMiddleware, async (req, res) => {
  try {
    const result = await addBonusSplit(supabase, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding bonus split:', error);
    res.status(500).json({ error: error.message || 'Failed to add bonus split' });
  }
});

router.put('/bonus-split/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await updateBonusSplit(supabase, id, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating bonus split:', error);
    res.status(500).json({ error: error.message || 'Failed to update bonus split' });
  }
});

router.delete('/bonus-split/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteBonusSplit(supabase, id);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting bonus split:', error);
    res.status(500).json({ error: error.message || 'Failed to delete bonus split' });
  }
});

router.post('/bonus-split/apply', authMiddleware, async (req, res) => {
  try {
    const result = await applyBonusSplitAction(supabase, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error applying bonus split:', error);
    res.status(500).json({ error: error.message || 'Failed to apply bonus split' });
  }
});

router.post('/bonus-split/revert', authMiddleware, async (req, res) => {
  try {
    const result = await revertBonusSplitAction(supabase, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error reverting bonus split:', error);
    res.status(500).json({ error: error.message || 'Failed to revert bonus split' });
  }
});

router.post('/bonus-split/apply-bulk', authMiddleware, async (req, res) => {
  try {
    const { records } = req.body;
    const result = await applyBulkBonusSplits(supabase, records);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error applying bulk bonus splits:', error);
    res.status(500).json({ error: error.message || 'Failed to apply bulk bonus splits' });
  }
});

router.post('/bonus-split/revert-bulk', authMiddleware, async (req, res) => {
  try {
    const { records } = req.body;
    const result = await revertBulkBonusSplits(supabase, records);
    invalidateStockCache();
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error reverting bulk bonus splits:', error);
    res.status(500).json({ error: error.message || 'Failed to revert bulk bonus splits' });
  }
});

router.post('/bonus-split/status-bulk', authMiddleware, async (req, res) => {
  try {
    const { ids, status } = req.body;
    const result = await updateBonusSplitStatusBulk(supabase, ids, status);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating bulk status:', error);
    res.status(500).json({ error: error.message || 'Failed to update bulk status' });
  }
});

/**
 * Stock Mapping Routes
 */
router.get('/mapping', authMiddleware, async (req, res) => {
  try {
    const result = await getAllStockMappings(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching stock mappings:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch stock mappings' });
  }
});

router.get('/mapping/incomplete', authMiddleware, async (req, res) => {
  try {
    const result = await getIncompleteStockMapping(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching incomplete stock mappings:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch incomplete stock mappings' });
  }
});

router.post('/mapping', authMiddleware, async (req, res) => {
  try {
    const result = await addStockMapping(supabase, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding stock mapping:', error);
    res.status(500).json({ error: error.message || 'Failed to add stock mapping' });
  }
});

router.put('/mapping/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await updateStockMapping(supabase, id, req.body);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating stock mapping:', error);
    res.status(500).json({ error: error.message || 'Failed to update stock mapping' });
  }
});

router.delete('/mapping/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteStockMapping(supabase, id);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting stock mapping:', error);
    res.status(500).json({ error: error.message || 'Failed to delete stock mapping' });
  }
});

/**
 * Stock Symbols Route
 */
router.get('/symbols', authMiddleware, async (req, res) => {
  try {
    const result = await getStockSymbols(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching stock symbols:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch stock symbols' });
  }
});

/**
 * Master Incomplete Route
 */
router.get('/master/incomplete', authMiddleware, async (req, res) => {
  try {
    const result = await getIncompleteStockMaster(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching incomplete stock master:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch incomplete stock master' });
  }
});

/**
 * GET /api/stock/watchlists
 * Get all watchlists
 */
router.get('/watchlists', authMiddleware, async (req, res) => {
  try {
    const result = await getAllWatchlists(supabase);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching all watchlists:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch all watchlists' });
  }
});

/**
 * POST /api/stock/watchlists
 * Add a new watchlist
 */
router.post('/watchlists', authMiddleware, async (req, res) => {
  try {
    const watchlistData = req.body;
    const result = await addWatchlist(supabase, watchlistData);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error adding watchlist:', error);
    res.status(500).json({ error: error.message || 'Failed to add watchlist' });
  }
});

/**
 * PUT /api/stock/watchlists/:id
 * Update an existing watchlist
 */
router.put('/watchlists/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const watchlistData = req.body;
    const result = await updateWatchlist(supabase, id, watchlistData);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error updating watchlist:', error);
    res.status(500).json({ error: error.message || 'Failed to update watchlist' });
  }
});

/**
 * GET /api/stock/equity-positions
 * Get equity positions
 */
router.get('/equity-positions', authMiddleware, async (req, res) => {
  try {
    console.log('[Stock API] Request received: GET /api/stock/equity-positions');
    const result = await getEquityPositions(supabase);
    if (result?.data) {
      console.log(`[Stock API] Returning ${result.data.length} equity positions`);
    }
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching equity positions:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch equity positions' });
  }
});

/**
 * DELETE /api/stock/equity-positions
 * Delete equity positions
 */
router.delete('/equity-positions', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    const result = await deleteEquityPositions(supabase, ids);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error deleting equity positions:', error);
    res.status(500).json({ error: error.message || 'Failed to delete equity positions' });
  }
});

/**
 * POST /api/stock/transactions/by-dates
 * Get transactions by dates
 */
router.post('/transactions/by-dates', authMiddleware, async (req, res) => {
  try {
    const { dates } = req.body;
    const result = await getStockTransactionsByDates(supabase, dates);
    res.json(result);
  } catch (error) {
    console.error('[Stock API] Error fetching transactions by dates:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch transactions by dates' });
  }
});

export default router;
