import { supabase } from '../db/supabaseClient.js';
import { fetchAndProcessGmailCAS } from './gmailCasService.js';
import logEmitter from '../utils/logger.js';

/**
 * Runs the gmailCasService with dependency checks
 */
export async function runGmailCasAutomation(account = null) {
    console.log(`🚀 [Automation] Starting gmailCasService automation...`);

    const accounts = account ? [account] : ['PM', 'PSM'];

    let overallSuccess = true;
    let errors = [];

    for (const acc of accounts) {
        try {
            const result = await fetchAndProcessGmailCAS(acc);

            if (!result.success) {
                overallSuccess = false;
                errors.push(`${acc}: ${result.message}`);
            } else {
                console.log(`✅ [Automation] Successfully processed Gmail CAS for ${acc}`);
            }
        } catch (err) {
            overallSuccess = false;
            console.error(`❌ [Automation] Failed to process Gmail CAS for ${acc}:`, err.message);
            errors.push(`${acc}: ${err.message}`);
        }
    }

    const logName = account
        ? `gmailCasService-${account}`
        : 'gmailCasService';

    if (overallSuccess) {
        await logEmitter.logScriptRun(logName, 'success');
        return true;
    } else {
        await logEmitter.logScriptRun(logName, 'failed', errors.join('; '));
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
// PM - Every Sunday at 9:00 AM
cron.schedule('0 9 * * 0', async () => {
    console.log('⏰ [Cron] Running PM CAS automation...');
    await runGmailCasAutomation('PM');
});

// PSM - Every Sunday at 2:00 PM
cron.schedule('0 14 * * 0', async () => {
    console.log('⏰ [Cron] Running PSM CAS automation...');
    await runGmailCasAutomation('PSM');
});

// Prune logs daily at midnight
cron.schedule('0 0 * * *', async () => {
    await pruneLogs();
});

console.log('✅ [Automation] CAS Automation initialized');
}
