import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as buyOrderController from '../controllers/buyOrderController.js';

const router = express.Router();

router.get('/stock-master', buyOrderController.getStockMaster);
router.get('/positions', buyOrderController.getOpenPositions);
router.post('/save-positions', buyOrderController.savePositionsToTransactions);
router.post('/sync-positions', buyOrderController.syncOpenPositions);
router.post('/place-buy-order', buyOrderController.placeBuyOrder);

export default router;
