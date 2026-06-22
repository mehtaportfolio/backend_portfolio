import express from 'express';
import { runManualUpdate } from '../services/nseIndexUpdater/scheduler.js';

const router = express.Router();

router.get('/update-indices', async (req, res) => {
  try {
    const result = await runManualUpdate();
    res.json({
      message: "NSE indices updated",
      status: "success",
      details: result
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update NSE indices",
      status: "error",
      error: error.message
    });
  }
});

export default router;
