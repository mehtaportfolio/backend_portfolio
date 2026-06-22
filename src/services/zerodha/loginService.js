import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { authenticator } from 'otplib';
import { KiteConnect } from 'kiteconnect';
import logger from './logger.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: '.env.backend' });

/**
 * Service to handle Zerodha automated login using Puppeteer
 */
class ZerodhaLoginService {
    constructor() {
        this.userId = process.env.ZERODHA_USER_ID;
        this.password = process.env.ZERODHA_PASSWORD;
        this.totpSecret = process.env.ZERODHA_TOTP_SECRET;
        this.apiKey = process.env.ZERODHA_API_KEY;
        this.apiSecret = process.env.ZERODHA_API_SECRET;
        this.redirectUrl = process.env.ZERODHA_REDIRECT_URL;
        this.debugDir = './debug-logs';
        
        if (!fs.existsSync(this.debugDir)) {
            fs.mkdirSync(this.debugDir);
        }
    }

    async takeScreenshot(page, stage) {
        try {
            const viewport = page.viewport();
            if (!viewport || page.isClosed()) return;

            const screenshotPath = path.join(this.debugDir, `debug-stage-${stage}-${Date.now()}.png`);
            await page.screenshot({
                path: screenshotPath,
                fullPage: true
            });
            logger.info(`Screenshot saved: ${screenshotPath} | URL: ${page.url()}`);
        } catch (err) {
            logger.warn(`Screenshot skipped for stage ${stage}: ${err.message}`);
        }
    }

    async waitForRequestToken(page, timeout = 30000) {
        const start = Date.now();
        logger.info('Starting request_token polling...');

        while (Date.now() - start < timeout) {
            try {
                if (page.isClosed()) break;
                
                const currentUrl = page.url();
                if (currentUrl.includes("request_token=")) {
                    logger.info("Request token detected in URL!");
                    const urlParams = new URLSearchParams(new URL(currentUrl).search);
                    const token = urlParams.get("request_token");
                    if (token) return token;
                }
            } catch (e) {
                // Ignore errors during navigation/polling
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return null;
    }

    /**
     * Automates the login process and returns request_token
     */
    async getRequestToken(accountId = null) {
        logger.info(`Starting Zerodha automated login for account: ${accountId || 'default'}...`);
        
        const isProduction = (process.env.NODE_ENV === 'production' || process.env.RENDER) && process.platform !== 'win32';
        
        const launchOptions = {
            executablePath: isProduction 
                ? await chromium.executablePath() 
                : (process.platform === 'win32' 
                    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' 
                    : '/usr/bin/google-chrome'),
            headless: isProduction ? chromium.headless : true,
            args: isProduction ? [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ] : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ],
            defaultViewport: isProduction ? chromium.defaultViewport : { width: 1280, height: 800 }
        };

        logger.info(`Launching browser with executable: ${launchOptions.executablePath}`);
        const browser = await puppeteer.launch(launchOptions);
        logger.info(`Browser launched successfully`);

        try {
            const page = await browser.newPage();
            
            // Set User Agent to avoid detection
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
            
            // Log all responses
            page.on("response", response => {
                const status = response.status();
                if (status >= 400) {
                    logger.warn(`Network Error: ${status} ${response.url()}`);
                }
            });

            // Set viewport for better consistency
            await page.setViewport({ width: 1280, height: 800 });

            // 1. Navigate to login page - added state parameter
            let loginUrl = `https://kite.trade/connect/login?v=3&api_key=${this.apiKey}&redirect_uri=${encodeURIComponent(this.redirectUrl)}`;
            if (accountId) {
                loginUrl += `&state=${accountId}`;
            }
            
            logger.info(`Navigating to login URL: ${loginUrl}`);
            await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });
            await this.takeScreenshot(page, '1-initial-load');

            // 2. Enter Credentials
            logger.info('Checking for login fields...');
            
            // Check if we are already logged in or need to enter User ID
            const userIdInput = await page.$('#userid');
            if (userIdInput) {
                logger.info('Entering User ID...');
                await page.type('#userid', this.userId, { delay: 100 });
                await page.click('button[type="submit"]');
                await new Promise(resolve => setTimeout(resolve, 1500)); 
                await this.takeScreenshot(page, '2-after-userid');
            }

            // Check for CAPTCHA
            const captchaImg = await page.$('#captcha_img');
            if (captchaImg) {
                await this.takeScreenshot(page, 'error-captcha');
                throw new Error('CAPTCHA detected. Automated login blocked. Please log in manually once to clear it.');
            }

            // Enter Password
            await page.waitForSelector('input[type="password"]', { timeout: 10000 });
            logger.info('Entering password...');
            await page.type('input[type="password"]', this.password, { delay: 100 });
            await this.takeScreenshot(page, '3-after-password-input');
            
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
            await page.click('button[type="submit"]');

            // 3. Handle TOTP
            logger.info('Waiting for TOTP field...');
            try {
                await page.waitForSelector('input[label="External TOTP"], #totp, .su-input-group input, input[type="text"]', { timeout: 15000 });
                await this.takeScreenshot(page, '4-totp-field-ready');
                
                logger.info('Generating TOTP...');
                const otp = authenticator.generate(this.totpSecret);
                
                const totpInput = await page.$('input[label="External TOTP"], #totp, .su-input-group input, input[type="text"]');
                await totpInput.type(otp, { delay: 150 });
                await this.takeScreenshot(page, '5-after-otp-input');
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Inspect buttons before clicking
                const buttonLabels = await page.$$eval("button", btns => btns.map(b => b.innerText.trim()));
                logger.info(`Available buttons: ${JSON.stringify(buttonLabels)}`);
                
                // Submit and immediately start polling for redirect
                await page.click('button[type="submit"]');
                logger.info('OTP submitted. Monitoring for redirect...');
            } catch (totpError) {
                // If we already have the token (happens if submit triggers immediate redirect)
                const token = await this.waitForRequestToken(page, 5000);
                if (token) return token;

                await this.takeScreenshot(page, 'error-totp');
                throw new Error(`TOTP step failed: ${totpError.message}`);
            }

            // 4. Robust Redirect Handling
            const requestToken = await this.waitForRequestToken(page, 30000);
            
            if (requestToken) {
                logger.info('Successfully captured request_token');
                return requestToken;
            }

            // 5. Handle potential intermediate screens ONLY if token not found
            logger.info('Token not found yet, checking for intermediate screens...');
            await this.takeScreenshot(page, '6-checking-intermediate');
            
            const intermediateButtons = [
                'button.button-orange',
                'button.actions',
                'button:contains("Continue")',
                'button:contains("Authorize")',
                'button:contains("Allow")'
            ];

            for (const selector of intermediateButtons) {
                try {
                    const btn = await page.$(selector);
                    if (btn) {
                        logger.info(`Intermediate button found: ${selector}. Clicking...`);
                        await btn.click();
                        
                        // Check again for token after intermediate click
                        const token = await this.waitForRequestToken(page, 10000);
                        if (token) return token;
                    }
                } catch (e) {
                    // Ignore selector errors
                }
            }

            // Final check
            const finalToken = await this.waitForRequestToken(page, 5000);
            if (finalToken) return finalToken;

            await this.takeScreenshot(page, 'error-redirect-timeout');
            const html = await page.content();
            fs.writeFileSync(path.join(this.debugDir, "zerodha-redirect-error.html"), html);
            throw new Error(`Redirect failed or timed out. Final URL: ${page.url()}`);

        } catch (error) {
            logger.error('Error during Zerodha login', error);
            throw error;
        } finally {
            await browser.close();
        }
    }

    /**
     * Generates access_token using request_token
     */
    async generateAccessToken(requestToken) {
        const kc = new KiteConnect({
            api_key: this.apiKey
        });

        try {
            logger.info('Generating session using request_token...');
            const response = await kc.generateSession(requestToken, this.apiSecret);
            logger.info('Access token generated successfully');
            return response;
        } catch (error) {
            logger.error('Error generating access token', error);
            throw error;
        }
    }

    /**
     * Full login flow: Login -> Get Request Token -> Generate Access Token
     */
    async loginAndGenerateToken(accountId = null, credentials = {}) {
        try {
            // Override credentials if provided
            if (credentials.apiKey) this.apiKey = credentials.apiKey;
            if (credentials.apiSecret) this.apiSecret = credentials.apiSecret;
            if (credentials.userId) this.userId = credentials.userId;
            if (credentials.password) this.password = credentials.password;
            if (credentials.totpSecret) this.totpSecret = credentials.totpSecret;

            const requestToken = await this.getRequestToken(accountId);
            const sessionData = await this.generateAccessToken(requestToken);
            return sessionData;
        } catch (error) {
            logger.error('Full login flow failed', error);
            throw error;
        }
    }
}

export default new ZerodhaLoginService();
