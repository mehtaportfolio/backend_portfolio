import express from 'express';
import multer from 'multer';
import { processNpsPdf } from '../services/npsPdfService.js';
import { supabase } from '../db/supabaseClient.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * GET /api/nps-pdf/transactions
 * Fetch all transactions from nps_pdf table
 */
router.get('/transactions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nps_pdf')
      .select('*')
      .order('date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Fetch NPS PDF Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/nps-pdf/upload
 * Expects 'file' as NPS PDF
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const result = await processNpsPdf(req.file.buffer);
    res.json(result);
  } catch (err) {
    console.error("NPS PDF Processing ERROR:", err);
    res.status(500).json({
      error: err.message || "NPS PDF processing failed",
    });
  }
});

export default router;
