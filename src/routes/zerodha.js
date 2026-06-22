import express from 'express';
const router = express.Router();

import { 
  zerodhaLogin, 
  zerodhaCallback, 
  fetchAndAggregateTrades 
} from '../services/zerodhaService.js';

// Login Route: /api/zerodha/login?account=Z1
router.get('/login', zerodhaLogin);

// Callback Route: /api/zerodha/callback (Redirect from Zerodha)
router.get('/callback', zerodhaCallback);

// Fetch & Aggregate Route: /api/zerodha/sync?account=Z1
router.get('/sync', fetchAndAggregateTrades);

export default router;
