import express from 'express';
import { searchSchemes } from '../services/schemeService.js';

const router = express.Router();

/**
 * GET /api/schemes/search?query=term
 * Returns a small list of scheme_list rows matching the provided query.
 */
router.get('/search', async (req, res, next) => {
  try {
    const query = String(req.query.query || '').trim();

    if (!query) {
      return res.json({ data: [], count: 0 });
    }

    const { data, error } = await searchSchemes(query, 25);

    if (error) {
      return res.status(500).json({ error: 'Failed to search schemes' });
    }

    return res.json({ data, count: data.length });
  } catch (error) {
    next(error);
  }
});

export default router;