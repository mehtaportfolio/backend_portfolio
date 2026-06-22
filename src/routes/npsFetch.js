import express from 'express';
import { initNpsSession, completeNpsLogin, parseNPS, saveTransactions } from '../services/npsFetchService.js';
import { getRawNPSTransactions } from '../services/assetService.js';
import logEmitter from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/nps-fetch/raw-transactions
 * Fetches transactions from nps_raw_temp
 */
router.get('/raw-transactions', async (req, res) => {
  try {
    const data = await getRawNPSTransactions();
    res.json(data);
  } catch (err) {
    console.error("NPS Raw Transactions ERROR:", err);
    res.status(500).json({ error: err.message || "Failed to fetch raw NPS transactions" });
  }
});

/**
 * POST /api/nps-fetch/init
 * Starts browser, navigates to login, returns captcha
 */
router.post('/init', async (req, res) => {
  const pran = process.env.NPS_PRAN;
  const password = process.env.NPS_PASSWORD;

  if (!pran || !password) {
    return res.status(500).json({ error: "NPS credentials not configured in backend" });
  }

  try {
    const sessionData = await initNpsSession({ pran, password });
    res.json({ success: true, ...sessionData });
  } catch (err) {
    console.error("NPS Init ERROR:", err);
    res.status(500).json({ error: err.message || "Failed to initialize NPS session" });
  }
});

/**
 * POST /api/nps-fetch/submit
 * Expects { sessionId, captchaValue, fy }
 */
router.post('/submit', async (req, res) => {
  const { sessionId, captchaValue, fy } = req.body;

  if (!sessionId || !captchaValue || !fy) {
    return res.status(400).json({ error: "Session ID, Captcha, and FY are required" });
  }

  try {
    const result = await completeNpsLogin(sessionId, captchaValue, fy);
    const parsed = parseNPS(result.data);
    const count = await saveTransactions(result.pran, parsed);
    await logEmitter.logScriptRun('npsFetchService', 'success', null, `manual_FY${fy}`);
    res.json({ success: true, message: `Successfully fetched and saved ${count} transactions for FY ${fy}.` });
  } catch (err) {
    if (err.newCaptcha) {
        // Return new captcha if login failed due to invalid captcha or "already logged in"
        return res.status(400).json({ 
            error: err.message, 
            retry: true, 
            captchaBase64: err.newCaptcha 
        });
    }
    console.error("NPS Submit ERROR:", err);
    await logEmitter.logScriptRun('npsFetchService', 'failed', err.message, `manual_FY${fy}`);
    res.status(500).json({ error: err.message || "NPS fetch failed" });
  }
});

export default router;
