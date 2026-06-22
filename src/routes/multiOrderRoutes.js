import express from 'express';
import * as multiOrderController from '../controllers/multiOrderController.js';

const router = express.Router();

// POST /api/orders/multi-buy - Place multiple buy orders
router.post('/multi-buy', multiOrderController.placeMultiBuyOrder);

// POST /api/orders/multi-sell - Place multiple sell orders
router.post('/multi-sell', multiOrderController.placeMultiSellOrder);

export default router;
