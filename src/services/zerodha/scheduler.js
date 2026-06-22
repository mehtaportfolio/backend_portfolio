import cron from 'node-cron';
import tokenManager from './tokenManager.js';
import logger from './logger.js';
import fundService from './fundService.js';

/**
 * Sets up scheduled tasks for Zerodha
 */
const initializeZerodhaScheduler = () => {
    logger.info('Initializing Zerodha daily scheduler...');

    // Schedule login at 8:00 AM IST every day
    cron.schedule('0 8 * * *', async () => {
        logger.info('Running scheduled Zerodha login and token refresh for all accounts (8:00 AM IST)...');
        const accounts = ['PM', 'PDM', 'PSM'];
        for (const account of accounts) {
            try {
                logger.info(`Starting scheduled refresh for ${account}...`);
                await tokenManager.refreshAccessToken(account);
                logger.info(`Scheduled Zerodha login and token refresh successful for ${account}`);
            } catch (error) {
                logger.error(`Scheduled Zerodha login failed for ${account}: ${error.message}`, error);
            }
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // Schedule Daily Fund Fetch - 4:00 PM IST
    cron.schedule('0 16 * * *', async () => {
        logger.info('Running scheduled Zerodha fund value fetch (4:00 PM IST)...');
        try {
            await fundService.fetchAndLogZerodhaFunds();
        } catch (error) {
            logger.error(`Scheduled Zerodha fund fetch failed: ${error.message}`);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // Optional: Schedule a health check or token validation at 8:15 AM IST
    cron.schedule('15 8 * * *', async () => {
        const accounts = ['PM', 'PDM', 'PSM'];
        logger.info('Running Zerodha token health check (8:15 AM IST)...');
        for (const account of accounts) {
            try {
                await tokenManager.loadTokenFromDB(account);
                const isValid = tokenManager.isTokenValid();
                logger.info(`Zerodha Token Health Check for ${account} (8:15 AM IST): ${isValid ? 'VALID' : 'INVALID'}`);
                if (!isValid) {
                    logger.warn(`Token invalid for ${account} at health check, attempting emergency refresh...`);
                    await tokenManager.refreshAccessToken(account);
                }
            } catch (error) {
                logger.error(`Health check failed for ${account}`, error);
            }
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    logger.info('Zerodha scheduler successfully initialized: 8:00 AM IST daily');
};

export default initializeZerodhaScheduler;
