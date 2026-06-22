const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs').promises;
const path = require('path');

async function debugChrome() {
    console.log("=== Puppeteer-Core & Chromium Debug Info ===");
    
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
    console.log(`Environment: ${isProduction ? 'Production/Render' : 'Local'}`);
    
    // Try launching
    console.log("\n=== Attempting to launch Chrome ===");
    try {
        const executablePath = isProduction 
            ? await chromium.executablePath() 
            : (process.platform === 'win32' 
                ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' 
                : '/usr/bin/google-chrome');
        
        console.log(`Using executable: ${executablePath}`);
        
        const browser = await puppeteer.launch({
            executablePath,
            headless: isProduction ? chromium.headless : true,
            args: isProduction ? [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ] : ['--no-sandbox', '--disable-setuid-sandbox']
        });
        console.log("✓ Browser launched successfully!");
        const version = await browser.version();
        console.log(`✓ Chrome version: ${version}`);
        await browser.close();
        console.log("✓ Browser closed successfully");
    } catch (err) {
        console.log(`✗ Launch failed: ${err.message}`);
        console.log(err.stack);
    }
}

debugChrome().then(() => console.log("\nDebug complete"));