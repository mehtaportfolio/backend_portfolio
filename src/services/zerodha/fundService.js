import kiteClient from './kiteClient.js';
import { supabase } from '../../db/supabaseClient.js';
import { insertRows, deleteRows, upsertRows, fetchAllRows } from '../../db/queries.js';
import logger from './logger.js';


/**
 * Fetches fund values (margins) for all Zerodha accounts and logs them to bank_transactions
 */
export async function fetchAndLogZerodhaFunds() {
    const accounts = ['PM', 'PDM', 'PSM'];
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    logger.info(`Starting daily Zerodha fund value fetch for ${today}...`);

    for (const account of accounts) {
        try {
            logger.info(`Fetching margins for Zerodha account: ${account}`);
            const margins = await kiteClient.getMargins(account);
            
            // Zerodha returns margins for equity and commodity
            // We'll use the equity 'available' or 'net' balance
            const equityMargins = margins.equity || {};

            // Some Zerodha responses may return NaN for balances.
            // bank_transactions.amount is NOT NULL, so we must always provide a valid number.
            // Normalize so bank_transactions.amount (NOT NULL) never receives null/NaN
            const rawAmount = equityMargins.net ?? equityMargins.available;
            const amountNum = rawAmount === null || rawAmount === undefined ? 0 : Number(rawAmount);
            const amount = Number.isFinite(amountNum) ? amountNum : 0;

            logger.info(`Account ${account} fund value: ${amount}`);


            results.push({
                account_name: account,
                account_type: 'Demat',
                txn_date: today,
                amount: amount,
                bank_name: 'KITE',
                is_adjustment: false,
                note: `Daily automated fund fetch at 4 PM`
            });
        } catch (error) {
            logger.error(`Failed to fetch margins for Zerodha account ${account}: ${error.message}`);
        }
    }

    if (results.length > 0) {
        try {
            // Insert only if current-month Demat rows are NOT found; otherwise update existing rows.
            // We update by account_name + bank_name + account_type within the current month.
            const today = new Date().toISOString().split('T')[0];
            const monthStart = new Date(today + 'T00:00:00');
            const nextMonth = new Date(monthStart);
            nextMonth.setMonth(monthStart.getMonth() + 1);

            const monthStartStr = monthStart.toISOString().split('T')[0];
            const nextMonthStr = nextMonth.toISOString().split('T')[0];

            // Build results grouped by account_name for safer update scope
            for (const row of results) {
                const { data: existingMonthDemat, error: fetchMonthErr } = await (async () => {
                    const { fetchAllRows } = await import('../../db/queries.js');
                    return await fetchAllRows(supabase, 'bank_transactions', {
                        select: 'id, account_name, account_type, txn_date, amount, bank_name',
                        filters: [
                            (q) => q.eq('account_type', 'Demat'),
                            (q) => q.gte('txn_date', monthStartStr),
                            (q) => q.lt('txn_date', nextMonthStr),
                            (q) => q.eq('bank_name', row.bank_name),
                            (q) => q.eq('account_name', row.account_name)
                        ]
                    });
                })();

                if (fetchMonthErr) throw fetchMonthErr;

                if (!existingMonthDemat || existingMonthDemat.length === 0) {
                    // No current-month row: insert
                    const { error: insertError } = await insertRows(supabase, 'bank_transactions', [row]);
                    if (insertError) throw insertError;
                } else {
                    // Current-month row exists: update via upsert by id
                    for (const existing of existingMonthDemat) {
                        const { error: updateError } = await (async () => {
                            const { upsertRows } = await import('../../db/queries.js');
                            return await upsertRows(supabase, 'bank_transactions', {
                                id: existing.id,
                                account_name: row.account_name,
                                account_type: 'Demat',
                                txn_date: today,
                                amount: row.amount,
                                bank_name: row.bank_name,
                                is_adjustment: false,
                                note: row.note
                            });
                        })();

                        if (updateError) throw updateError;
                    }
                }
            }

            logger.info(`Processed ${results.length} Zerodha fund values for current-month Demat rows (insert/update)`);
        } catch (error) {
            logger.error(`Error saving Zerodha fund values to database: ${error.message}`);
        }
    }

    // Cleanup logic: delete rows older than 3 months
    await cleanupOldBankTransactions();
}

/**
 * Deletes bank_transactions rows older than 3 months for Demat accounts
 */
async function cleanupOldBankTransactions() {
    try {
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const dateStr = threeMonthsAgo.toISOString().split('T')[0];

        logger.info(`Cleaning up bank_transactions older than ${dateStr} (3 months) for Demat...`);
        
        const { error } = await deleteRows(supabase, 'bank_transactions', (q) => 
            q.lt('txn_date', dateStr)
             .eq('account_type', 'Demat')
             .eq('bank_name', 'KITE')
        );

        if (error) throw error;
        logger.info(`Successfully cleaned up old Zerodha Demat bank_transactions records`);
    } catch (error) {
        logger.error(`Failed to cleanup old bank_transactions: ${error.message}`);
    }
}


export default {
    fetchAndLogZerodhaFunds,
    cleanupOldBankTransactions
};
