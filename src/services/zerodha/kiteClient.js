import { KiteConnect } from 'kiteconnect';
import tokenManager from './tokenManager.js';
import logger from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Reusable Kite client wrapper
 */
class KiteClient {
    constructor() {
        this.kc = null;
        this.apiKey = process.env.ZERODHA_API_KEY;
    }

    /**
     * Initializes or returns the KiteConnect instance
     */
    async getInstance(accountId = null) {
        try {
            const accessToken = await tokenManager.getValidAccessToken(accountId);
            
            // Get correct API key based on account
            let apiKey = this.apiKey;
            if (accountId === 'PM') apiKey = process.env.KITE_API_KEY_Z1;
            else if (accountId === 'PDM') apiKey = process.env.KITE_API_KEY_Z2;
            else if (accountId === 'PSM') apiKey = process.env.KITE_API_KEY_Z3;

            if (!this.kc || this.kc.api_key !== apiKey) {
                this.kc = new KiteConnect({
                    api_key: apiKey,
                    access_token: accessToken
                });
            } else {
                this.kc.access_token = accessToken;
            }
            
            return this.kc;
        } catch (error) {
            logger.error('Failed to initialize Kite instance', error);
            throw error;
        }
    }

    /**
     * Fetch user profile
     */
    async getProfile(accountId = null) {
        const kc = await this.getInstance(accountId);
        return await kc.getProfile();
    }

    /**
     * Fetch holdings
     */
    async getHoldings(accountId = null) {
        const kc = await this.getInstance(accountId);
        return await kc.getHoldings();
    }

    /**
     * Fetch positions
     */
    async getPositions(accountId = null) {
        const kc = await this.getInstance(accountId);
        return await kc.getPositions();
    }

    /**
     * Fetch orders
     */
    async getOrders(accountId = null) {
        const kc = await this.getInstance(accountId);
        return await kc.getOrders();
    }

    /**
     * Place order
     */
    async placeOrder(params, accountId = null) {
        const kc = await this.getInstance(accountId);
        return await kc.placeOrder(params.variety || "regular", params);
    }

    /**
     * Fetch funds/margins
     */
    async getMargins(accountId = null) {
        const kc = await this.getInstance(accountId);
        return await kc.getMargins();
    }

    /**
     * Utility to check if client is ready
     */
    async isReady(accountId = null) {
        try {
            await this.getProfile(accountId);
            return true;
        } catch (error) {
            return false;
        }
    }
}

export default new KiteClient();
