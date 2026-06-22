import { supabase } from '../db/supabaseClient.js';
import { fetchAndProcessGmailCAS } from './gmailCasService.js';
import logEmitter from '../utils/logger.js';

/**
 * Runs the gmailCasService with dependency checks
 */
export async function runGmailCasAutomation() {
    console.log(`🚀 [Automation] Starting gmailCasService automation...`);

    const accounts = ['PM', 'PSM'];
    let overallSuccess = true;
    let errors = [];

    for (const account of accounts) {
        try {
            const result = await fetchAndProcessGmailCAS(account);
            if (!result.success) {
                overallSuccess = false;
                errors.push(`${account}: ${result.message}`);
            } else {
                console.log(`✅ [Automation] Successfully processed Gmail CAS for ${account}`);
            }
        } catch (err) {
            overallSuccess = false;
            console.error(`❌ [Automation] Failed to process Gmail CAS for ${account}:`, err.message);
            errors.push(`${account}: ${err.message}`);
        }
    }

    if (overallSuccess) {
        await logEmitter.logScriptRun('gmailCasService', 'success');
        return true;
    } else {
        await logEmitter.logScriptRun('gmailCasService', 'failed', errors.join('; '));
        return false;
    }
}

/**
 * Prunes script_logs table to keep only current and previous month
 */
export async function pruneLogs() {
    console.log('🧹 [Automation] Pruning script_logs...');
    try {
        const now = new Date();
        // Get the first day of the previous month
        const firstDayPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const cutoffDate = firstDayPrevMonth.toISOString();

        const { error, count } = await supabase
            .from('script_logs')
            .delete({ count: 'exact' })
            .lt('created_at', cutoffDate);

        if (error) {
            console.error('❌ [Automation] Error pruning logs:', error.message);
        } else {
            console.log(`✅ [Automation] Pruned ${count} old logs. Kept logs from ${cutoffDate} onwards.`);
        }
    } catch (err) {
        console.error('❌ [Automation] Unexpected error pruning logs:', err.message);
    }
}

/**
 * Initialize all cron jobs for CAS automation
 */
export function initCasAutomation(cron) {
    // 1. gmailCasService every 8 hours
    cron.schedule('0 */8 * * *', async () => {
        console.log('⏰ [Cron] Triggering gmailCasService automation (Every 8 hours)...');
        await runGmailCasAutomation();
    });

    // 2. Prune logs daily at midnight
    cron.schedule('0 0 * * *', async () => {
        await pruneLogs();
    });

    console.log('✅ [Automation] CAS Automation (Gmail only) initialized');
}
