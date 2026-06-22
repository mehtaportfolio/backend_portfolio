import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { processCAS } from '../services/casService.js';
import { fetchAndProcessGmailCAS } from '../services/gmailCasService.js';
import logEmitter from '../utils/logger.js';

const router = express.Router();

// Memory storage is better for processing small files without leaving local leftovers
const storage = multer.memoryStorage();
const upload = multer({ storage });

/**
 * POST /api/cas/upload
 * Expects 'file' as CAS PDF and 'accountName' in the body
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { accountName } = req.body;
    if (!accountName) {
      return res.status(400).json({ error: "Account name is required" });
    }

    const buffer = req.file.buffer;
    const result = await processCAS(buffer, accountName);

    res.json(result);
  } catch (err) {
    console.error("CAS Processing ERROR:", err);
    res.status(500).json({
      error: err.message || "CAS processing failed",
    });
  }
});

/**
 * POST /api/cas/gmail-fetch
 * Connects to Gmail and fetches latest CAS
 */
router.post('/gmail-fetch', async (req, res) => {
  const { accountName } = req.body;
  try {
    if (!accountName) {
      return res.status(400).json({ error: "Account name is required" });
    }

    const result = await fetchAndProcessGmailCAS(accountName);
    if (result.success) {
      await logEmitter.logScriptRun('gmailCasService', 'success', null, `manual_${accountName}`);
    } else {
      await logEmitter.logScriptRun('gmailCasService', 'failed', result.message, `manual_${accountName}`);
    }
    res.json(result);
  } catch (err) {
    console.error("CAS Gmail-Fetch ERROR:", err);
    await logEmitter.logScriptRun('gmailCasService', 'failed', err.message, `manual_${accountName}`);
    res.status(500).json({
      error: err.message || "CAS gmail-fetch failed",
    });
  }
});

/**
 * GET /api/cas/script-logs
 * Fetches script logs with optional filters
 */
router.get('/script-logs', async (req, res) => {
  try {
    const { serviceName, status, month } = req.query;
    const { supabase } = await import('../db/supabaseClient.js');

    let query = supabase
      .from('script_logs')
      .select('*')
      .order('created_at', { ascending: false });

    if (serviceName) {
      query = query.eq('service_name', serviceName);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (month) {
      // month is expected in YYYY-MM format
      const startDate = `${month}-01T00:00:00Z`;
      const date = new Date(month);
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      const endDate = `${month}-${lastDay}T23:59:59Z`;
      query = query.gte('created_at', startDate).lte('created_at', endDate);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Fetch Script Logs ERROR:", err);
    res.status(500).json({ error: err.message || "Failed to fetch logs" });
  }
});

/**
 * GET /api/cas/logs
 * SSE endpoint for live logs
 */
router.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onLog = (message) => {
    res.write(`data: ${JSON.stringify({ message })}\n\n`);
  };

  logEmitter.on('log', onLog);

  req.on('close', () => {
    logEmitter.removeListener('log', onLog);
  });
});

export default router;
