import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { processCAS } from '../services/casService.js';

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

export default router;
