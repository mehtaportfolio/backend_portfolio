/**
 * Dashboard API Routes
 * GET /api/dashboard/asset-allocation - Asset allocation data
 * GET /api/dashboard/summary - Quick summary
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { cacheMiddleware } from '../middleware/cache.js';
import { getDashboardAssetAllocation, getDashboardSummary } from '../services/dashboardService.js';

const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const CACHE_TTL = parseInt(process.env.CACHE_TTL_DASHBOARD || '5', 10);

/**
 * GET /api/dashboard/asset-allocation
 * Returns asset-wise breakdown with allocations and P&L
 * Query params:
 *   - userId: User ID (default: primary accounts)
 *   - priceSource: 'stock_master' or 'stock_mapping' (default: 'stock_master')
 */
router.get(
  '/asset-allocation',
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      // Use 'all' accounts by default to match Bank Assets page totals
      const userId = req.userId || req.query.userId || 'all';
      const priceSource = req.query.priceSource || 'stock_master';

      const result = await getDashboardAssetAllocation(supabase, userId, priceSource);

      res.json({
        success: true,
        data: result,
        cache: res.getHeader('X-Cache'),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/dashboard/summary
 * Returns quick portfolio summary
 * Query params:
 *   - userId: User ID (default: primary accounts)
 *   - priceSource: 'stock_master' or 'stock_mapping' (default: 'stock_master')
 */
router.get(
  '/summary',
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      const userId = req.userId || req.query.userId || 'all';
      const priceSource = req.query.priceSource || 'stock_master';

      const summary = await getDashboardSummary(supabase, userId, priceSource);

      res.json({
        success: true,
        data: summary,
        cache: res.getHeader('X-Cache'),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;