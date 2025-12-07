/**
 * Assets API Routes
 * Endpoints for Bank, NPS, BDM, EPF, PPF data
 */

import express from 'express';
import authMiddleware from '../middleware/auth.js';
import cache from '../middleware/cache.js';
import { getBankData, getNPSData, getBDMData, getEPFData, getPPFData, getMFData } from '../services/assetService.js';

const router = express.Router();

/**
 * GET /api/assets/bank
 * Fetch all bank transactions with summaries
 */
router.get('/bank', async (req, res, next) => {
  try {
    const data = await getBankData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/nps
 * Fetch all NPS transactions and fund master
 */
router.get('/nps', async (req, res, next) => {
  try {
    const data = await getNPSData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/bdm
 * Fetch all BDM transactions
 */
router.get('/bdm', async (req, res, next) => {
  try {
    const data = await getBDMData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/epf
 * Fetch all EPF transactions with company aggregation
 */
router.get('/epf', async (req, res, next) => {
  try {
    const data = await getEPFData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/ppf
 * Fetch all PPF transactions with account summaries
 */
router.get('/ppf', async (req, res, next) => {
  try {
    const data = await getPPFData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/mf
 * Fetch all mutual fund transactions, master data, and processed holdings
 */
router.get('/mf', async (req, res, next) => {
  try {
    const data = await getMFData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/bank/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const bankKeys = allKeys.filter(key => key.includes('/api/assets/bank'));
    bankKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${bankKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/bdm/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const bdmKeys = allKeys.filter(key => key.includes('/api/assets/bdm'));
    bdmKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${bdmKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/epf/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const epfKeys = allKeys.filter(key => key.includes('/api/assets/epf'));
    epfKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${epfKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/ppf/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const ppfKeys = allKeys.filter(key => key.includes('/api/assets/ppf'));
    ppfKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${ppfKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/nps/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const npsKeys = allKeys.filter(key => key.includes('/api/assets/nps'));
    npsKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${npsKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/mf/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const mfKeys = allKeys.filter(key => key.includes('/api/assets/mf'));
    mfKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${mfKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/cashflow/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const cashflowKeys = allKeys.filter(key => key.includes('/api/assets/cashflow'));
    cashflowKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${cashflowKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/other/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const otherKeys = allKeys.filter(key => key.includes('/api/assets/other'));
    otherKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${otherKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

export default router;