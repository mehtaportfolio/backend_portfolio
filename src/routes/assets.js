/**
 * Assets API Routes
 * Endpoints for Bank, NPS, BDM, EPF, PPF data
 */

import express from 'express';
import axios from 'axios';
import authMiddleware from '../middleware/auth.js';
import cache from '../middleware/cache.js';
import { 
  getBankData, getNPSData, getBDMData, getEPFData, getPPFData, getMFData,
  getMFAccountNames, addMFTransaction, addBulkMFTransactions, addMFMaster,
  addMFSIP, updateMFTransaction, deleteMFTransaction, getMFCasEntries, deleteAllMFCasEntries,
  getMFRawCasEntries,
  getBankMetadata, addBankTransaction, addBulkBankTransactions, getBankTransactionsByRange,
  getBankSnapshots,
  updateBankBalanceSnapshot, deleteBankBalanceSnapshot,
  updateBankTransaction, deleteBankTransaction, processBankAdjustment,

  getAssetDistinctNames, addAssetTransaction, addBulkAssetTransactions, getAssetTransactionsByRange,
  updateAssetTransaction, deleteAssetTransaction, getAssetTransactions,
  getNPSMasterData, getAssetLatestDate, addAssetContribution, updateMFSIP, deleteMFSIP,
  getUserMasterData, updateUserMasterData, addUserMasterData, deleteUserMasterData,
  getUserDetails, updateUserDetails, getLatestUpdates, getBulkExportData,
  getMFExplorerFunds, getProfileData, getBDMAccountNumber
} from '../services/assetService.js';

const router = express.Router();

/**
 * GET /api/assets/mf/proxy/:id
 * Proxy for public MF API to avoid CORS issues
 */
router.get('/mf/proxy/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`https://api.mfapi.in/mf/${id}`);
    res.json(response.data);
  } catch (error) {
    console.error(`MF Proxy Error for ID ${req.params.id}:`, error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch data from MF API',
      details: error.message
    });
  }
});

/**
 * GET /api/assets/bank
 * Fetch all bank transactions with summaries
 */
router.get('/bank', authMiddleware, async (req, res, next) => {
  try {
    const data = await getBankData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/bank/metadata', authMiddleware, async (req, res, next) => {
  try {
    const data = await getBankMetadata();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/bank/range', authMiddleware, async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await getBankTransactionsByRange(startDate, endDate);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/bank/snapshots', authMiddleware, async (req, res, next) => {
  try {
    const data = await getBankSnapshots();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// --- Bank Balance Snapshots (CRUD)
router.put('/bank/snapshot/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await updateBankBalanceSnapshot(req.params.id, req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/bank/snapshot/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await deleteBankBalanceSnapshot(req.params.id);
    res.json(data);
  } catch (error) {
    next(error);
  }
});


router.post('/bank/transaction', authMiddleware, async (req, res, next) => {
  try {
    const data = await addBankTransaction(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.put('/bank/transaction/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await updateBankTransaction(req.params.id, req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/bank/transaction/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await deleteBankTransaction(req.params.id);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/bank/adjustment', authMiddleware, async (req, res, next) => {
  try {
    const data = await processBankAdjustment();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/bank/bulk', authMiddleware, async (req, res, next) => {
  try {
    const data = await addBulkBankTransactions(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/nps
 * Fetch all NPS transactions and fund master
 */
router.get('/nps', authMiddleware, async (req, res, next) => {
  try {
    const data = await getNPSData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/bdm
 * Fetch all BDM transactions
 */
router.get('/bdm', authMiddleware, async (req, res, next) => {
  try {
    const data = await getBDMData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/epf
 * Fetch all EPF transactions with company aggregation
 */
router.get('/epf', authMiddleware, async (req, res, next) => {
  try {
    const data = await getEPFData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/ppf
 * Fetch all PPF transactions with account summaries
 */
router.get('/ppf', authMiddleware, async (req, res, next) => {
  try {
    const data = await getPPFData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/assets/mf
 * Fetch all mutual fund transactions, master data, and processed holdings
 */
router.get('/mf', authMiddleware, async (req, res, next) => {
  try {
    const { priceSource = 'stock_master' } = req.query;
    const data = await getMFData(priceSource);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/mf/accounts', authMiddleware, async (req, res, next) => {
  try {
    const data = await getMFAccountNames();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/mf/explorer/funds', authMiddleware, async (req, res, next) => {
  try {
    const data = await getMFExplorerFunds();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/mf/transaction', authMiddleware, async (req, res, next) => {
  try {
    const data = await addMFTransaction(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/mf/bulk', authMiddleware, async (req, res, next) => {
  try {
    const data = await addBulkMFTransactions(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/mf/master', authMiddleware, async (req, res, next) => {
  try {
    const data = await addMFMaster(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/mf/sip', authMiddleware, async (req, res, next) => {
  try {
    const data = await addMFSIP(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.put('/mf/sip/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await updateMFSIP(req.params.id, req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/mf/sip/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await deleteMFSIP(req.params.id);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.put('/mf/transaction/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await updateMFTransaction(req.params.id, req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/mf/transaction/:id', authMiddleware, async (req, res, next) => {
  try {
    const data = await deleteMFTransaction(req.params.id);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/mf/cas', authMiddleware, async (req, res, next) => {
  try {
    const data = await getMFCasEntries();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/mf/raw-cas', authMiddleware, async (req, res, next) => {
  try {
    const data = await getMFRawCasEntries();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/mf/cas', authMiddleware, async (req, res, next) => {
  try {
    const data = await deleteAllMFCasEntries();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/bank/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const bankKeys = allKeys.filter(key => key.includes('/api/assets/bank'));
    bankKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${bankKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/bdm/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const bdmKeys = allKeys.filter(key => key.includes('/api/assets/bdm'));
    bdmKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${bdmKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/epf/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const epfKeys = allKeys.filter(key => key.includes('/api/assets/epf'));
    epfKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${epfKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/ppf/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const ppfKeys = allKeys.filter(key => key.includes('/api/assets/ppf'));
    ppfKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${ppfKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/nps/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const npsKeys = allKeys.filter(key => key.includes('/api/assets/nps'));
    npsKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${npsKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/mf/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const mfKeys = allKeys.filter(key => key.includes('/api/assets/mf'));
    mfKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${mfKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/cashflow/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const cashflowKeys = allKeys.filter(key => key.includes('/api/assets/cashflow'));
    cashflowKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${cashflowKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.post('/other/invalidate-cache', authMiddleware, (req, res) => {
  try {
    const allKeys = cache.stats().keys;
    const otherKeys = allKeys.filter(key => key.includes('/api/assets/other'));
    otherKeys.forEach(key => cache.delete(key));
    res.json({ success: true, message: `Cleared ${otherKeys.length} cache entries` });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to invalidate cache' });
  }
});

router.get('/:assetType/transactions', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.params;
    const { select, filters, order } = req.query;
    
    const tableMap = {
      other: 'other_transactions',
      cashflow: 'account_cashflows',
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
      bank: 'bank_transactions'
    };
    
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const options = {
      select: select || '*',
      filters: filters ? JSON.parse(filters) : [],
      order: order ? JSON.parse(order) : { column: 'date', ascending: false }
    };

    const data = await getAssetTransactions(tableName, options);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.put('/:assetType/transaction/:id', authMiddleware, async (req, res, next) => {
  try {
    const { assetType, id } = req.params;
    const tableMap = {
      other: 'other_transactions',
      cashflow: 'account_cashflows',
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const data = await updateAssetTransaction(tableName, id, req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/:assetType/transaction/:id', authMiddleware, async (req, res, next) => {
  try {
    const { assetType, id } = req.params;
    const tableMap = {
      other: 'other_transactions',
      cashflow: 'account_cashflows',
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const data = await deleteAssetTransaction(tableName, id);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/:assetType/latest-date', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.params;
    const { dateColumn = 'date' } = req.query;
    
    const tableMap = {
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const data = await getAssetLatestDate(tableName, dateColumn);
    res.json({ date: data });
  } catch (error) {
    next(error);
  }
});

router.post('/:assetType/contribution', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.params;
    const tableMap = {
      nps: 'nps_contributions',
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type for contribution' });

    const data = await addAssetContribution(tableName, req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

// Generic Asset Routes (EPF, PPF, NPS, BDM, etc.)
router.get('/:assetType/names/:columnName', authMiddleware, async (req, res, next) => {
  try {
    const { assetType, columnName } = req.params;
    const tableMap = {
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
      cashflow: 'account_cashflows',
      other: 'other_transactions'
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });
    
    const data = await getAssetDistinctNames(tableName, columnName);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/nps/master', authMiddleware, async (req, res, next) => {
  try {
    const data = await getNPSMasterData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/:assetType/range', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.params;
    const { startDate, endDate, dateColumn = 'date' } = req.query;
    
    const tableMap = {
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const data = await getAssetTransactionsByRange(tableName, dateColumn, startDate, endDate);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/:assetType/transaction', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.params;
    const tableMap = {
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
      cashflow: 'account_cashflows',
      other: 'other_transactions'
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const data = await addAssetTransaction(tableName, req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/:assetType/bulk', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.params;
    const tableMap = {
      epf: 'epf_transactions',
      ppf: 'ppf_transactions',
      nps: 'nps_transactions',
      bdm: 'bdm_transactions',
    };
    const tableName = tableMap[assetType];
    if (!tableName) return res.status(400).json({ error: 'Invalid asset type' });

    const data = await addBulkAssetTransactions(tableName, req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/bdm/account-number', authMiddleware, async (req, res, next) => {
  try {
    const data = await getBDMAccountNumber();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/user-master', authMiddleware, async (req, res, next) => {
  try {
    const { assetType } = req.query;
    const data = await getUserMasterData(assetType);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.put('/user-master/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await updateUserMasterData(id, req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/user-master', authMiddleware, async (req, res, next) => {
  try {
    const data = await addUserMasterData(req.body);
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

router.delete('/user-master/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await deleteUserMasterData(id);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/profile', authMiddleware, async (req, res, next) => {
  try {
    const data = await getProfileData();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/user-details', authMiddleware, async (req, res, next) => {
  try {
    const data = await getUserDetails();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.put('/user-details', authMiddleware, async (req, res, next) => {
  try {
    const data = await updateUserDetails(req.body);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/latest-updates', authMiddleware, async (req, res, next) => {
  try {
    const data = await getLatestUpdates();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/export', authMiddleware, async (req, res, next) => {
  try {
    const { tables } = req.body;
    if (!tables || !Array.isArray(tables)) {
      return res.status(400).json({ error: 'Tables must be an array' });
    }
    const data = await getBulkExportData(tables);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
