import cron from 'node-cron';
import { supabase } from '../db/supabaseClient.js';
import { deleteRows } from '../db/queries.js';

/**
 * Cleanup bank_transactions older than 3 months for Savings account type
 */
export async function cleanupSavingsTransactions() {
    try {
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const dateStr = threeMonthsAgo.toISOString().split('T')[0];

        console.log(`[Maintenance] Cleaning up Savings bank_transactions older than ${dateStr}...`);
        
        const { error } = await deleteRows(supabase, 'bank_transactions', (q) => 
            q.lt('txn_date', dateStr).eq('account_type', 'Savings')
        );

        if (error) throw error;
        console.log(`[Maintenance] Successfully cleaned up old Savings bank_transactions records`);
    } catch (error) {
        console.error(`[Maintenance] Failed to cleanup Savings bank_transactions: ${error.message}`);
    }
}

/**
 * Initialize maintenance schedules
 */
export function initMaintenanceService() {
    console.log('[Maintenance] Initializing maintenance service...');

    // Schedule cleanup at 1:00 AM IST daily
    cron.schedule('0 1 * * *', async () => {
        console.log('[Maintenance] Running scheduled Savings transaction cleanup (1:00 AM IST)...');
        await cleanupSavingsTransactions();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    console.log('[Maintenance] Maintenance service initialized: 1:00 AM IST daily');
}

export default {
    cleanupSavingsTransactions,
    initMaintenanceService
};
