import express from 'express';
import { supabase } from '../db/supabaseClient.js';
import { triggerPortfolioUpdate } from '../services/notificationService.js';

const router = express.Router();

// Subscribe to push notifications
router.post('/subscribe', async (req, res, next) => {
  try {
    const { subscription } = req.body;
    
    if (!subscription) {
      return res.status(400).json({ error: 'Subscription is required' });
    }

    // Check if subscription already exists
    const { data: existing } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('subscription->endpoint', subscription.endpoint)
      .single();

    if (existing) {
      return res.status(200).json({ message: 'Already subscribed' });
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .insert([{ subscription }]);

    if (error) throw error;

    res.status(201).json({ message: 'Subscribed successfully' });
  } catch (error) {
    next(error);
  }
});

// Trigger a notification (can be called by cron-job.org)
router.get('/trigger', async (req, res, next) => {
  try {
    const force = req.query.force === 'true';
    const result = await triggerPortfolioUpdate(force);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
