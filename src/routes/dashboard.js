/**
 * Dashboard API Routes
 * GET /api/dashboard/asset-allocation - Asset allocation data
 * GET /api/dashboard/summary - Quick summary
 */

import express from 'express';
import { supabase } from '../db/supabaseClient.js';
import { cacheMiddleware } from '../middleware/cache.js';
import authMiddleware from '../middleware/auth.js';
import { getDashboardAssetAllocation, getDashboardSummary, getLivePriceDetails, getInvestmentGrowth } from '../services/dashboardService.js';

const router = express.Router();

const CACHE_TTL = parseInt(process.env.CACHE_TTL_DASHBOARD || '5', 10);

/**
 * GET /api/dashboard/asset-allocation
 * Returns asset-wise breakdown with allocations and P&L
 * Query params:
 *   - priceSource: 'stock_master' or 'stock_mapping' (default: 'stock_master')
 */
router.get(
  '/asset-allocation',
  authMiddleware,
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      const priceSource = req.query.priceSource || 'stock_master';

      const result = await getDashboardAssetAllocation(supabase, priceSource);

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
 *   - priceSource: 'stock_master' or 'stock_mapping' (default: 'stock_master')
 */
router.get(
  '/summary',
  authMiddleware,
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      const priceSource = req.query.priceSource || 'stock_master';

      const summary = await getDashboardSummary(supabase, priceSource);

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

/**
 * GET /api/dashboard/live-price-details
 * Returns stock transaction details for live price calculation
 * Requires authentication
 */
router.get(
  '/live-price-details',
  authMiddleware,
  async (req, res, next) => {
    try {
      const result = await getLivePriceDetails(supabase);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/dashboard/investment-growth
 * Returns year-wise investment growth data
 */
router.get(
  '/investment-growth',
  authMiddleware,
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      const priceSource = req.query.priceSource || 'stock_master';

      const result = await getInvestmentGrowth(supabase, priceSource);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;