import express from 'express';
import { fetchFundReturns, fetchFundMeta } from '../services/fundService.js';

const router = express.Router();

/**
 * GET /funds/meta
 * Fetches and parses NAVAll.txt from AMFI for all funds metadata.
 */
router.get('/meta', async (req, res, next) => {
  try {
    const meta = await fetchFundMeta();
    res.json(meta);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /funds/:amfiCode/returns
 * Fetches and calculates standard and rolling returns for a given scheme code.
 */
router.get('/:amfiCode/returns', async (req, res, next) => {
  try {
    const { amfiCode } = req.params;
    if (!amfiCode) {
      return res.status(400).json({ error: 'amfiCode is required' });
    }

    const data = await fetchFundReturns(amfiCode);
    res.json(data);
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

export default router;
