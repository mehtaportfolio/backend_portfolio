import express from 'express';
import { getAnalysisDashboard, getAnalysisSummary, getAnalysisFreeStocks, getTopMutualFunds, getEarningData } from '../services/analysisService.js';
import { getAccountAnalysis } from '../services/accountAnalysisService.js';
import { getFixedAssetTotals } from '../services/fixedAssetService.js';
import { supabase } from '../db/supabaseClient.js';
import authMiddleware from '../middleware/auth.js';
import { cacheMiddleware } from '../middleware/cache.js';

const router = express.Router();

const ANALYSIS_CACHE_TTL = parseInt(process.env.CACHE_TTL_ANALYSIS || '5', 10);

// Analysis Dashboard - Account-wise stocks, top gainers/losers
router.get('/dashboard', cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM', 'BDM'];
    const priceSource = req.query.priceSource || 'stock_master';
    
    const data = await getAnalysisDashboard(userId, priceSource);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/account-dashboard', cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM', 'BDM'];
    const priceSource = req.query.priceSource || 'stock_master';
    
    const data = await getAccountAnalysis(supabase, userId, priceSource);
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
router.get('/summary', cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM', 'BDM'];
    const priceSource = req.query.priceSource || 'stock_master';
    
    const data = await getAnalysisSummary(userId, priceSource);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// Free Stocks Analysis
router.get('/free-stocks', cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM', 'BDM'];
    const priceSource = req.query.priceSource || 'stock_master';
    
    const data = await getAnalysisFreeStocks(userId, priceSource);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// Earning Data for Earning Tab
router.get('/earning', cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM', 'BDM'];
    const data = await getEarningData(userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// Fixed Assets for Home Page (Bank, EPF, PPF, FD)
router.get('/fixed-assets', authMiddleware, cacheMiddleware(ANALYSIS_CACHE_TTL), async (req, res, next) => {
  try {
    const userId = req.userId || req.query.userId || ['PM', 'PDM', 'PSM', 'BDM'];
    const data = await getFixedAssetTotals(supabase, userId);
    res.json({
      success: true,
      data,
      cache: res.getHeader('X-Cache'),
    });
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