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
 */
router.get(
  '/asset-allocation',
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      // Use the primary accounts by default to match notification/portfolio logic
      const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM'];

      const result = await getDashboardAssetAllocation(supabase, userId);

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
 */
router.get(
  '/summary',
  cacheMiddleware(CACHE_TTL),
  async (req, res, next) => {
    try {
      const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM'];

      const summary = await getDashboardSummary(supabase, userId);

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