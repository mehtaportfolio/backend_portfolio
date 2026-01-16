import express from 'express';
import cache from '../middleware/cache.js';

const router = express.Router();

/**
 * POST /api/cache/clear
 * Clears all in-memory cache
 */
router.post('/clear', (req, res) => {
  try {
    cache.clear();
    res.json({
      success: true,
      message: 'Cache cleared successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to clear cache',
      error: error.message
    });
  }
});

export default router;
