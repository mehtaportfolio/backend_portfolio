// backend/src/routes/dividend.js
import express from 'express';
import { runDividendAutomation } from '../services/dividendService.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

/**
 * Trigger dividend automation: sync and apply
 * POST /api/dividend/automate
 */
router.post('/automate', authMiddleware, async (req, res, next) => {
  try {
    const result = await runDividendAutomation();
    res.json({ status: 'success', ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
