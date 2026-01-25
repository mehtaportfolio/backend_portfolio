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
} from '../services/stockService.js';
import { supabase } from '../db/supabaseClient.js';

const router = express.Router();

/**
 * GET /api/stock/open
 * Fetch open stock holdings with XIRR
 */
router.get('/open', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = await getOpenStockData(supabase, userId);
    res.json(data);
  } catch (error) {
    console.error('[Stock API] Error fetching open stock data:', error);
    res
      .status(500)
      .json({ error: error.message || 'Failed to fetch open stock data' });
  }
});

/**
 * GET /api/stock/closed
 * Fetch closed stock holdings
 */
router.get('/closed', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = await getClosedStockData(supabase, userId);
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
 */
router.get('/etf', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = await getETFData(supabase, userId);
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
 */
router.get('/portfolio', authMiddleware, cacheMiddleware(5), async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = await getPortfolioData(supabase, userId);
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
    console.log('[Stock Cache] All cache keys before invalidation:', allKeys);
    
    const stockKeys = allKeys.filter(key => 
      key.includes('/open:') || 
      key.includes('/closed:') || 
      key.includes('/etf:') || 
      key.includes('/portfolio:')
    );
    
    console.log(`[Stock Cache] Found ${stockKeys.length} stock keys to invalidate:`, stockKeys);
    
    stockKeys.forEach(key => {
      console.log(`[Stock Cache] Deleting: ${key}`);
      cache.delete(key);
    });
    
    console.log(`[Stock Cache] ✅ Invalidated ${stockKeys.length} cache entries`);
    
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
    const userId = req.user?.id;
    const { stockName, accountType } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!stockName || !accountType) {
      return res.status(400).json({ error: 'Stock name and account type are required' });
    }

    const result = await bulkUpdateAccountType(supabase, userId, stockName, accountType);
    
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

export default router;
