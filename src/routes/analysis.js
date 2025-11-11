import express from 'express';
import { getAnalysisDashboard, getAnalysisSummary, getAnalysisFreeStocks, getTopMutualFunds } from '../services/analysisService.js';
import { getAccountAnalysis } from '../services/accountAnalysisService.js';
import { createClient } from '@supabase/supabase-js';
import { cacheMiddleware } from '../middleware/cache.js';

const router = express.Router();

const ANALYSIS_CACHE_TTL = parseInt(process.env.CACHE_TTL_ANALYSIS || '5', 10);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Analysis Dashboard - Account-wise stocks, top gainers/losers
router.get('/dashboard', async (req, res, next) => {
  try {
    const data = await getAnalysisDashboard();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/account-dashboard', cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || 'test-user';
    const data = await getAccountAnalysis(supabase, userId);
    res.json({
      success: true,
      data,
      cache: res.getHeader('X-Cache'),
    });
  } catch (error) {
    next(error);
  }
});

// Analysis Summary - Active/Closed equity and MF positions
router.get('/summary', async (req, res, next) => {
  try {
    const data = await getAnalysisSummary();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// Free Stocks Analysis
router.get('/free-stocks', async (req, res, next) => {
  try {
    const data = await getAnalysisFreeStocks();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// Top Mutual Funds
router.get('/top-mutual-funds', async (req, res, next) => {
  try {
    const { sortBy = 'absReturnPct', sortDirection = 'desc' } = req.query;
    const data = await getTopMutualFunds(sortBy, sortDirection);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;