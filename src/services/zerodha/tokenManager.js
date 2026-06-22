import { supabase } from '../../db/supabaseClient.js';
import loginService from './loginService.js';
import logger from './logger.js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.backend' });

class ZerodhaTokenManager {
    constructor() {
        this.tokenData = null;
        this.accountId = process.env.ZERODHA_ACCOUNT_NICKNAME || process.env.ZERODHA_USER_ID;
    }

    /**
     * Retrieves valid access token, refreshing if necessary
     */
    async getValidAccessToken(accountId = null) {
        try {
            const effectiveAccountId = accountId || this.accountId;
            await this.loadTokenFromDB(effectiveAccountId);

            if (this.isTokenValid()) {
                logger.info(`Using existing valid Zerodha access token for ${effectiveAccountId} from Supabase`);
                return this.tokenData.access_token;
            }

            logger.info(`Zerodha token for ${effectiveAccountId} expired or missing. Refreshing...`);
            return await this.refreshAccessToken(effectiveAccountId);
        } catch (error) {
            logger.error('Failed to get valid access token', error);
            throw error;
        }
    }

    /**
     * Checks if current token is valid (Zerodha tokens are valid for one day)
     */
    isTokenValid() {
        if (!this.tokenData || !this.tokenData.access_token) return false;

        const updatedAt = new Date(this.tokenData.updated_at);
        const now = new Date();

        // Zerodha tokens expire daily at 6 AM next day.
        // We consider it valid if it was updated today.
        return updatedAt.toDateString() === now.toDateString();
    }

    /**
     * Refreshes access token with retry logic
     */
    async refreshAccessToken(accountId = null, retries = 3) {
        const effectiveAccountId = accountId || this.accountId;
        
        // Helper to get credentials (minimal version to avoid circular dependency with zerodhaService.js)
        const getCreds = (accId) => {
            if (accId === 'PM') return { apiKey: process.env.KITE_API_KEY_Z1, apiSecret: process.env.KITE_API_SECRET_Z1, userId: process.env.ZERODHA_USER_ID_Z1, password: process.env.ZERODHA_PASSWORD_Z1, totpSecret: process.env.ZERODHA_TOTP_SECRET_Z1 };
            if (accId === 'PDM') return { apiKey: process.env.KITE_API_KEY_Z2, apiSecret: process.env.KITE_API_SECRET_Z2, userId: process.env.ZERODHA_USER_ID_Z2, password: process.env.ZERODHA_PASSWORD_Z2, totpSecret: process.env.ZERODHA_TOTP_SECRET_Z2 };
            if (accId === 'PSM') return { apiKey: process.env.KITE_API_KEY_Z3, apiSecret: process.env.KITE_API_SECRET_Z3, userId: process.env.ZERODHA_USER_ID_Z3, password: process.env.ZERODHA_PASSWORD_Z3, totpSecret: process.env.ZERODHA_TOTP_SECRET_Z3 };
            return {};
        };

        const credentials = getCreds(effectiveAccountId);

        for (let i = 0; i < retries; i++) {
            try {
                logger.info(`Token refresh attempt ${i + 1}/${retries} for ${effectiveAccountId}...`);
                const sessionData = await loginService.loginAndGenerateToken(effectiveAccountId, credentials);
                
                const newTokenData = {
                    account_id: effectiveAccountId,
                    access_token: sessionData.access_token,
                    public_token: sessionData.public_token,
                    updated_at: new Date().toISOString()
                };
                
                await this.saveTokenToDB(newTokenData);
                this.tokenData = newTokenData;
                
                logger.info(`Zerodha token for ${effectiveAccountId} refreshed and saved to Supabase`);
                return this.tokenData.access_token;
            } catch (error) {
                logger.error(`Attempt ${i + 1} failed for ${effectiveAccountId}: ${error.message}`);

                // If it's a "Token used" error, it means the callback handler already updated the DB
                if (error.message.includes('Token') && error.message.includes('used')) {
                    logger.info('Token already exchanged by callback handler. Loading from DB...');
                    await this.loadTokenFromDB(effectiveAccountId);
                    if (this.isTokenValid()) return this.tokenData.access_token;
                }

                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, (i + 1) * 5000));
            }
        }
    }

    async loadTokenFromDB(accountId = null) {
        try {
            const effectiveAccountId = accountId || this.accountId;
            const { data, error } = await supabase
                .from('zerodha_tokens')
                .select('*')
                .eq('account_id', effectiveAccountId)
                .order('updated_at', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 is 'No rows found'
                throw error;
            }

            this.tokenData = data;
        } catch (error) {
            logger.warn('Error loading token from Supabase', error.message);
            this.tokenData = null;
        }
    }

    async saveTokenToDB(tokenData) {
        try {
            // Delete existing tokens for this account to keep the table clean
            await supabase
                .from('zerodha_tokens')
                .delete()
                .eq('account_id', tokenData.account_id);

            // Insert new token
            const { error } = await supabase
                .from('zerodha_tokens')
                .insert(tokenData);

            if (error) throw error;
            
            logger.info(`Zerodha token for ${tokenData.account_id} saved to Supabase (old tokens cleared)`);
        } catch (error) {
            logger.error('Error saving token to Supabase', error);
        }
    }
}

export default new ZerodhaTokenManager();
