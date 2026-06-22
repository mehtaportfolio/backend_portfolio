import express from 'express';
import * as orderController from '../controllers/orderController.js';

const router = express.Router();

router.get('/distinct-brokers-accounts', orderController.getDistinctBrokersAndAccounts);
router.get('/distinct-stock-names', orderController.getDistinctStockNames);
router.get('/open-transactions', orderController.getOpenTransactions);
router.post('/place-sell-order', orderController.placeSellOrder);
router.get('/order-status', orderController.getOrderStatus);

export default router;
