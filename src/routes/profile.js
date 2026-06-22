import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { supabase } from '../db/supabaseClient.js';

const router = express.Router();

/**
 * GET /api/profile/accounts
 * Get user's demat accounts
 */
router.get('/accounts', authMiddleware, async (req, res) => {
  try {
    // For now, return empty array since demat accounts are stored in localStorage
    // TODO: Migrate demat accounts to database
    const accounts = [];
    res.json(accounts);
  } catch (error) {
    console.error('[Profile] Error fetching accounts:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch accounts' });
  }
});

/**
 * POST /api/profile/accounts
 * Add or update demat account
 */
router.post('/accounts', authMiddleware, async (req, res) => {
  try {
    const { accountName, panNumber, dematAccounts } = req.body;
    // TODO: Implement database storage for demat accounts
    // For now, this is a placeholder
    res.json({ success: true, message: 'Account saved successfully' });
  } catch (error) {
    console.error('[Profile] Error saving account:', error);
    res.status(500).json({ error: error.message || 'Failed to save account' });
  }
});

/**
 * PUT /api/profile/accounts/:id
 * Update demat account
 */
router.put('/accounts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { accountName, panNumber, dematAccounts } = req.body;
    // TODO: Implement database update for demat accounts
    res.json({ success: true, message: 'Account updated successfully' });
  } catch (error) {
    console.error('[Profile] Error updating account:', error);
    res.status(500).json({ error: error.message || 'Failed to update account' });
  }
});

/**
 * DELETE /api/profile/accounts/:id
 * Delete demat account
 */
router.delete('/accounts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // TODO: Implement database deletion for demat accounts
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('[Profile] Error deleting account:', error);
    res.status(500).json({ error: error.message || 'Failed to delete account' });
  }
});

/**
 * GET /api/profile/settings
 * Get user profile settings
 */
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    // TODO: Implement user settings storage
    const settings = {
      theme: 'light',
      notifications: {
        profitThreshold: 170,
        telegramEnabled: false
      },
      biometric: {
        enabled: false
      }
    };
    res.json(settings);
  } catch (error) {
    console.error('[Profile] Error fetching settings:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch settings' });
  }
});

/**
 * PUT /api/profile/settings
 * Update user profile settings
 */
router.put('/settings', authMiddleware, async (req, res) => {
  try {
    const settings = req.body;
    // TODO: Implement user settings storage
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('[Profile] Error updating settings:', error);
    res.status(500).json({ error: error.message || 'Failed to update settings' });
  }
});

export default router;