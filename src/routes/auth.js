import express from 'express';
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows, updateRows } from '../db/queries.js';

const router = express.Router();

/**
 * POST /api/auth/signup
 * Register a new user
 */
router.post('/signup', async (req, res) => {
  const { email, password, options } = req.body;
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options
    });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/logout
 * Logout user
 */
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const { error } = await supabase.auth.admin.signOut(token);
      // Note: signOut might not work as expected with just a token in admin context
      // but we can just return success as the client will clear its token anyway.
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/auth/session
 * Get current session info (requires valid token)
 */
router.get('/session', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) throw error;
    res.json({ user });
  } catch (error) {
    res.status(401).json({ error: 'Invalid session' });
  }
});

/**
 * GET /api/auth/user-details
 * Fetch user details from user_details table
 */
router.get('/user-details', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const { data, error } = await fetchAllRows(supabase, 'user_details', {
      filters: [(q) => q.eq('user_email', email.toLowerCase())],
      limit: 1
    });

    if (error) throw error;
    res.json(data[0] || null);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/update-user
 * Update user data (metadata)
 */
router.post('/update-user', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const { data } = req.body;
  try {
    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw userError;
    
    const { data: updatedUser, error: updateError } = await supabase.auth.admin.updateUserById(
      currentUser.id,
      { user_metadata: data }
    );
    if (updateError) throw updateError;
    
    res.json(updatedUser);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/verify-master-pin
 * Verify master PIN (6-digit)
 */
router.post('/verify-master-pin', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const { pin } = req.body;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw userError;

    const { data, error } = await fetchAllRows(supabase, 'user_details', {
      select: 'master_password',
      filters: [(q) => q.eq('user_email', user.email.toLowerCase())],
      limit: 1
    });

    if (error) throw error;

    if (data && data.length > 0 && data[0].master_password === pin) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Incorrect PIN' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/update-master-pin
 * Update master PIN
 */
router.post('/update-master-pin', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const { currentPin, newPin } = req.body;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw userError;

    // Verify current PIN
    const { data: userDetails, error: fetchError } = await fetchAllRows(supabase, 'user_details', {
      select: 'master_password',
      filters: [(q) => q.eq('user_email', user.email.toLowerCase())],
      limit: 1
    });

    if (fetchError) throw fetchError;

    if (!userDetails || userDetails.length === 0 || userDetails[0].master_password !== currentPin) {
      return res.status(400).json({ success: false, message: 'Incorrect current PIN' });
    }

    // Update to new PIN
    const { error: updateError } = await updateRows(supabase, 'user_details', 
      { master_password: newPin }, 
      (q) => q.eq('user_email', user.email.toLowerCase())
    );

    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/verify-master-password
 * Verify master password
 */
router.post('/verify-master-password', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const { password } = req.body;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw userError;

    const { data, error } = await fetchAllRows(supabase, 'user_details', {
      select: 'user_password',
      filters: [(q) => q.eq('user_email', user.email.toLowerCase())],
      limit: 1
    });

    if (error) throw error;

    if (data && data.length > 0 && data[0].user_password === password) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Incorrect master password' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/update-user-details
 * Update user details (like user_password)
 */
router.post('/update-user-details', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const { updates } = req.body;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw userError;

    const { error: updateError } = await updateRows(supabase, 'user_details', updates, 
      (q) => q.eq('user_email', user.email.toLowerCase())
    );

    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;

// Unauthenticated helper endpoint to update master_password for a user
// Accepts { email, currentPassword, newPassword }
// Verifies currentPassword against stored user_password then updates master_password
router.post('/update-master-password-unauth', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (!email || !currentPassword || !newPassword) return res.status(400).json({ error: 'email, currentPassword and newPassword are required' });
  try {
    const { data: userRows, error: fetchError } = await fetchAllRows(supabase, 'user_details', {
      select: 'user_password',
      filters: [(q) => q.eq('user_email', email.toLowerCase())],
      limit: 1
    });
    if (fetchError) throw fetchError;
    if (!userRows || userRows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    if (userRows[0].user_password !== currentPassword) {
      return res.status(400).json({ success: false, message: 'Incorrect current password' });
    }

    const { error: updateError } = await updateRows(supabase, 'user_details', { master_password: newPassword }, (q) => q.eq('user_email', email.toLowerCase()));
    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
