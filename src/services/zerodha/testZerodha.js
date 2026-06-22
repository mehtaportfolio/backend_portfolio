import kiteClient from './kiteClient.js';
import logger from './logger.js';
import initializeZerodhaScheduler from './scheduler.js';

/**
 * Test script to verify Zerodha automation in backend
 */
async function testZerodhaAutomation() {
    logger.info('--- Starting Zerodha Automation Test (Backend) ---');
    
    try {
        // 1. Test Profile Fetch
        logger.info('Attempting to fetch profile (this may trigger automated login)...');
        const profile = await kiteClient.getProfile();
        
        logger.info('SUCCESS! Profile fetched:');
        console.log({
            user_id: profile.user_id,
            user_name: profile.user_name,
            email: profile.email,
            broker: profile.broker
        });

        // 2. Test Holdings Fetch
        logger.info('Attempting to fetch holdings...');
        const holdings = await kiteClient.getHoldings();
        logger.info(`SUCCESS! Found ${holdings.length} holdings.`);

        // 3. Test Scheduler Initialization
        logger.info('Testing scheduler initialization...');
        initializeZerodhaScheduler();
        
        logger.info('--- Zerodha Automation Test Completed Successfully ---');
        process.exit(0);
    } catch (error) {
        logger.error('FATAL: Zerodha Automation Test Failed', error);
        process.exit(1);
    }
}

testZerodhaAutomation();
