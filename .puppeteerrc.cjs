const { resolve } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Use a local path within the project to ensure Render persists the browser binary
  // We use puppeteer-cache (non-hidden) to ensure it's included in the deployment
  cacheDirectory: resolve(__dirname, 'puppeteer-cache'),
};
