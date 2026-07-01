// ✅ Polyfill browser-only objects for pdfjs-dist in Node environment
if (typeof global.window === 'undefined') {
  global.window = global;
}
global.process.browser = false;
if (typeof global.location === 'undefined') {
  global.location = { href: 'http://localhost', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '', pathname: '/', search: '', hash: '' };
}
if (typeof global.window.location === 'undefined') {
  global.window.location = global.location;
}
if (typeof global.self === 'undefined') {
  global.self = global;
}
if (typeof global.navigator === 'undefined') {
  global.navigator = { userAgent: 'node' };
}
if (typeof global.document === 'undefined') {
  global.document = {
    createElement: () => ({
      getContext: () => ({})
    })
  };
}
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {
    constructor() {
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
    }
  };
}
if (typeof global.ImageData === 'undefined') {
  global.ImageData = class ImageData {
    constructor() {}
  };
}
if (typeof global.Path2D === 'undefined') {
  global.Path2D = class Path2D {
    constructor() {}
  };
}
if (typeof global.CanvasRenderingContext2D === 'undefined') {
  global.CanvasRenderingContext2D = class CanvasRenderingContext2D {
    constructor() {}
  };
}
if (typeof global.HTMLCanvasElement === 'undefined') {
  global.HTMLCanvasElement = class HTMLCanvasElement {
    constructor() {}
  };
}
if (typeof global.DOMPoint === 'undefined') {
  global.DOMPoint = class DOMPoint {
    constructor() {}
  };
}
if (typeof global.DOMRect === 'undefined') {
  global.DOMRect = class DOMRect {
    constructor() {}
  };
}
if (typeof global.HTMLElement === 'undefined') {
  global.HTMLElement = class HTMLElement {
    constructor() {}
  };
}
if (typeof global.Image === 'undefined') {
  global.Image = class Image {
    constructor() {}
  };
}
if (typeof global.OffscreenCanvas === 'undefined') {
  global.OffscreenCanvas = class OffscreenCanvas {
    constructor() {}
    getContext() { return {}; }
  };
}
if (typeof global.Blob === 'undefined') {
  // Use global Blob if available (Node 18+), else mock it
  if (typeof Blob === 'undefined') {
    global.Blob = class Blob {
      constructor() {}
    };
  } else {
    global.Blob = Blob;
  }
}
if (typeof global.XMLSerializer === 'undefined') {
  global.XMLSerializer = class XMLSerializer {
    constructor() {}
    serializeToString() { return ''; }
  };
}

// ✅ Load environment variables FIRST (before anything else)
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve .env.backend path (one level up from src/)
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.backend');
dotenv.config({ path: envPath, override: false });

// -------------------------------------------------------------
// Import core dependencies (safe to import now)
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cron from 'node-cron';
import errorHandler from './middleware/errorHandler.js';
import authMiddleware from './middleware/auth.js';
import cacheMiddleware from './middleware/cache.js';


// -------------------------------------------------------------
// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Simple request logging middleware
// app.use((req, res, next) => {
//   console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
//   next();
// });

// -------------------------------------------------------------
// Global Middleware
const rawCorsOrigins = process.env.CORS_ORIGIN || 'http://localhost:3000,https://mehta-wealths-dashboard.vercel.app';

const allowedOrigins = rawCorsOrigins
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
  

app.use(
  cors({
    origin: (origin, callback) => {
      
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      
      if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
      
      const isAllowed = allowedOrigins.some((o) => origin === o || origin.startsWith(o));
      if (isAllowed) return callback(null, true);
      
      console.warn(`⚠️ CORS blocked for origin: ${origin}`);
      return callback(null, false); // Return false instead of error to avoid crashing
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.use(express.json());

// Add global error handlers to prevent crash restarts
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

// -------------------------------------------------------------
// Root routes for Render keep-alive and restart simulation
app.get('/', (req, res) => {
  res.json({ status: 'backend up', timestamp: new Date().toISOString() });
});

app.post('/', (req, res) => {
  // Simulate restart request (Render free tier doesn't support API restarts)
  res.status(202).json({ message: 'Service is already running' });
});

// Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post("/restart", (req, res) => {
  res.json({ status: "info", message: "Service is running. Server restart not required." });
});

// -------------------------------------------------------------
// ✅ Dynamically import routes and init functions AFTER dotenv is loaded
const { default: authRoutes } = await import('./routes/auth.js');
const { default: webauthnRoutes } = await import('./routes/webauthn.js');
const { default: dashboardRoutes } = await import('./routes/dashboard.js');
const { default: analysisRoutes } = await import('./routes/analysis.js');
const { default: assetsRoutes } = await import('./routes/assets.js');
const { default: stockRoutes } = await import('./routes/stocks.js');
const { default: profileRoutes } = await import('./routes/profile.js');
const { default: schemesRoutes } = await import('./routes/schemes.js');
const { default: cacheRoutes } = await import('./routes/cache.js');
const { default: notificationRoutes } = await import('./routes/notifications.js');
const { default: dividendRoutes } = await import('./routes/dividend.js');
const { default: nseRoutes } = await import('./routes/nse.js');
const { default: fundsRoutes } = await import('./routes/funds.js');
const { default: casRoutes } = await import('./routes/cas.js');
const { default: camsRoutes } = await import('./routes/cams.js');
const { default: npsPdfRoutes } = await import('./routes/npsPdf.js');
const { default: npsFetchRoutes } = await import('./routes/npsFetch.js');
const { default: zerodhaRoutes } = await import('./routes/zerodha.js');
const { default: orderRoutes } = await import('./routes/orderRoutes.js');
const { default: buyOrderRoutes } = await import('./routes/buyOrderRoutes.js');
const { default: multiOrderRoutes } = await import('./routes/multiOrderRoutes.js');
const { sendAngelOneStatusNotification } = await import('./services/notificationService.js');
const { initializeStockMapping } = await import('./db/initStockMapping.js');
const { initLivePriceServer, loginToAngel } = await import('./services/angelLiveService.js');

const { startAngelOneService, refreshStockSymbols, syncMarketData, fetchTodayBuyTrades, syncMarketIndices, getAngelStatus } = await import('./services/angelOneService.js');

// Attach routes
app.use('/api/auth', authRoutes);
app.use('/api/webauthn', webauthnRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/schemes', schemesRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dividend', dividendRoutes);
app.use('/api/nse', nseRoutes);
app.use('/funds', fundsRoutes);
app.use('/api/cas', casRoutes);
app.use('/api/cams', camsRoutes);
app.use('/api/nps-pdf', npsPdfRoutes);
app.use('/api/nps-fetch', npsFetchRoutes);
app.use('/api/zerodha', zerodhaRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/orders', multiOrderRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/buy-order', buyOrderRoutes);

// ✅ Add direct kite callback route (Zerodha's expected redirect URL)
const { zerodhaCallback } = await import('./services/zerodhaService.js');
const { startCorpActionService } = await import('./services/corpActionService/index.js');
const { runAngelPriceFixService } = await import('./services/angelPriceFixService.js');
const { initNSEIndexUpdater } = await import('./services/nseIndexUpdater/scheduler.js');
const { startOrderTracker } = await import('./services/orderTrackerService.js');
const { startBrokerOrdersCleanup } = await import('./services/brokerOrdersCleanupService.js');
const { initCasAutomation } = await import('./services/casAutomationService.js');
const { initAmfiNavService, updateAllFundsNAV, fetchNAVByDate } = await import('./services/amfiNavService.js');
const { default: initializeZerodhaScheduler } = await import('./services/zerodha/scheduler.js');
const { initMaintenanceService } = await import('./services/maintenanceService.js');
const { initializeCASScheduler } = await import('./services/casScheduler.js');
app.get('/kite/callback', zerodhaCallback);

// 🔹 Corporate Action manual trigger route
app.get('/api/run-corp-actions', async (req, res) => {
  const days = req.query.days ? parseInt(req.query.days) : 30;
  try {
    // Run in background
    startCorpActionService(days);
    res.json({ status: 'success', message: `Corporate action sync for ${days} days started in background` });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 🔹 Angel Price Fix manual trigger route
app.get('/api/run-angel-fix', async (req, res) => {
  try {
    // Run in background
    runAngelPriceFixService();
    res.json({ status: 'success', message: 'Angel One Price Fix background service started' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 🔹 Maintenance manual trigger route
app.get('/api/run-maintenance', async (req, res) => {
  try {
    const { cleanupSavingsTransactions } = await import('./services/maintenanceService.js');
    cleanupSavingsTransactions();
    res.json({ status: 'success', message: 'Maintenance tasks (Savings cleanup) triggered in background' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 🔹 Manual trigger: Zerodha + Angel One fund sync
app.post('/api/sync-funds/zerodha', authMiddleware, async (req, res) => {
  try {
    await (await import('./services/zerodha/fundService.js')).fetchAndLogZerodhaFunds();
    res.json({ status: 'success', message: 'Zerodha fund values synced' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message || 'Zerodha fund sync failed' });
  }
});

app.post('/api/sync-funds/angel-one', authMiddleware, async (req, res) => {
  try {
    await (await import('./services/angelOneService.js')).fetchAndLogAngelFunds();
    res.json({ status: 'success', message: 'Angel One fund values synced' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message || 'Angel One fund sync failed' });
  }
});


// 🔄 Cache invalidation endpoints for various asset types (from server.old.js)
const cacheInvalidationHandler = async (req, res) => {
  try {
    const { default: cache } = await import('./middleware/cache.js');
    const { clearFundCache } = await import('./services/fundService.js');
    cache.clear();
    clearFundCache();
    res.json({ status: "ok", message: "Cache invalidated" });
  } catch (err) {
    console.error("Cache invalidation error:", err);
    res.status(500).json({ error: "Failed to invalidate cache" });
  }
};

app.post("/api/mf/invalidate-cache", cacheInvalidationHandler);
app.post("/api/stock/invalidate-cache", cacheInvalidationHandler);
app.post("/api/nps/invalidate-cache", cacheInvalidationHandler);
app.post("/api/assets/bank/invalidate-cache", cacheInvalidationHandler);
app.post("/api/assets/bdm/invalidate-cache", cacheInvalidationHandler);
app.post("/api/sip/invalidate-cache", cacheInvalidationHandler);
app.post("/api/:assetType/invalidate-cache", cacheInvalidationHandler);

// 🔹 Proxy endpoint for Render service deployment/restart
app.post('/api/render/deploy', async (req, res) => {
  const { serviceName, clearCache = 'clear' } = req.body;

  // Map service names to IDs and specific API Keys securely on the backend
  const serviceConfigs = {
    'backend': {
      id: process.env.RENDER_BACKEND_SERVICE_ID || 'srv-d6fvbm450q8c738226tg',
      key: process.env.RENDER_BACKEND_API_KEY || process.env.RENDER_API_KEY
    },
    'googlesheet': {
      id: process.env.RENDER_GOOGLESHEET_SERVICE_ID || 'srv-d6tn2fggjchc73ci49q0',
      key: process.env.RENDER_GOOGLESHEET_API_KEY || 'rnd_PEjcaqNNrPy1OWPXzlgBd1I6Dywi'
    }
  };

  const config = serviceConfigs[serviceName];

  if (!config || !config.id) {
    return res.status(400).json({ status: 'error', message: 'Valid serviceName is required' });
  }

  const token = config.key;

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Render API key is missing on server for this service' });
  }

  try {
    const response = await axios.post(
      `https://api.render.com/v1/services/${config.id}/deploys`,
      { clearCache },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }
      }
    );

    res.status(response.status).json({ ...response.data, serviceId: config.id });
  } catch (error) {
    console.error(`❌ Error triggering Render deploy for ${serviceName} (${config.id}):`, error.message);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.response?.data?.message || error.message || 'Failed to trigger Render deploy',
      error: error.response?.data
    });
  }
});

// 🔹 Proxy endpoint to get Render deploy status
app.get('/api/render/deploy/:serviceName/:deployId', async (req, res) => {
  const { serviceName, deployId } = req.params;

  const serviceConfigs = {
    'backend': {
      id: process.env.RENDER_BACKEND_SERVICE_ID || 'srv-d6fvbm450q8c738226tg',
      key: process.env.RENDER_BACKEND_API_KEY || process.env.RENDER_API_KEY
    },
    'googlesheet': {
      id: process.env.RENDER_GOOGLESHEET_SERVICE_ID || 'srv-d6tn2fggjchc73ci49q0',
      key: process.env.RENDER_GOOGLESHEET_API_KEY || 'rnd_PEjcaqNNrPy1OWPXzlgBd1I6Dywi'
    }
  };

  const config = serviceConfigs[serviceName];

  if (!config || !config.id || !deployId) {
    return res.status(400).json({ status: 'error', message: 'Valid serviceName and deployId are required' });
  }

  const token = config.key;

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Render API key is missing on server for this service' });
  }

  try {
    const response = await axios.get(
      `https://api.render.com/v1/services/${config.id}/deploys/${deployId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(`❌ Error fetching Render deploy status for ${deployId}:`, error.message);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.response?.data?.message || error.message || 'Failed to fetch deploy status',
      error: error.response?.data
    });
  }
});

// 🔹 Angel One internal service endpoints
app.post('/api/fetch-nav-by-date', async (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ status: 'error', message: 'Date is required' });
  }
  try {
    const result = await fetchNAVByDate(date);
    res.json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/amfi/trigger', async (req, res) => {
  try {
    updateAllFundsNAV();
    res.json({ status: 'success', message: 'AMFI NAV update triggered in background' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/angel-one-health', (req, res) => {
  res.json({
    status: 'success',
    message: 'Angel One internal service is running',
    timestamp: new Date().toISOString()
  });
});

// System health endpoint: checks Supabase connectivity and Angel service status
app.get('/api/health', async (req, res) => {
  const result = {
    status: 'ok',
    services: {},
    timestamp: new Date().toISOString()
  };

  // Check Supabase by performing a light query
  try {
    const { supabase } = await import('./db/supabaseClient.js');
    // Try a small select on a commonly present table
    const { data, error, status } = await supabase.from('stock_symbols').select('name').limit(1);
    if (error) {
      result.services.supabase = { ok: false, error: error.message || error };
      result.status = 'degraded';
    } else {
      result.services.supabase = { ok: true, rows: Array.isArray(data) ? data.length : 0 };
    }
  } catch (err) {
    result.services.supabase = { ok: false, error: err.message };
    result.status = 'degraded';
  }

  // Angel One service status from module
  try {
    const angelStatus = getAngelStatus();
    result.services.angel = angelStatus;
    if (angelStatus.circuitOpen) result.status = 'degraded';
  } catch (err) {
    result.services.angel = { ok: false, error: err.message };
    result.status = 'degraded';
  }

  res.json(result);
});

app.get('/refresh-stocks', async (req, res) => {
  try {
    const result = await refreshStockSymbols();
    res.json({
      status: "success",
      message: `✅ Stock list refreshed: ${result.count} stocks processed`
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: `❌ Stock refresh failed: ${error.message}` });
  }
});

app.post(['/sync', '/sync-cmp'], async (req, res) => {
  try {
    await syncMarketData();
    res.json({ status: 'success', message: '✅ CMP Sync completed successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: `❌ CMP Sync failed: ${error.message}` });
  }
});

app.post('/sync-indices', async (req, res) => {
  try {
    await syncMarketIndices();
    res.json({ status: 'success', message: '✅ Market Indices Sync completed successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: `❌ Market Indices Sync failed: ${error.message}` });
  }
});

app.post('/sync-lcp', async (req, res) => {
  try {
    await syncMarketData();
    res.json({ status: 'success', message: '✅ LCP Sync completed successfully' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: `❌ LCP Sync failed: ${error.message}` });
  }
});

app.get('/fetch-buy-trades', async (req, res) => {
  try {
    await fetchTodayBuyTrades();
    res.json({ status: 'success', message: '✅ Buy trades aggregated & stored' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Proxy endpoints for other Render services
app.post('/indices/restart', async (req, res) => {
  try {
    const response = await axios.post('https://nse-indices-v3mk.onrender.com/restart', {}, { timeout: 60000 });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ status: 'error', message: error.message });
  }
});

app.post('/angel-price/trigger', async (req, res) => {
  try {
    // Run in background
    runAngelPriceFixService();
    res.json({ status: 'success', message: 'Internal Angel One Price Fix service triggered' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/corp-action/trigger', async (req, res) => {
  try {
    const response = await axios.get('https://corp-action-backend-cics.onrender.com/trigger', { timeout: 60000 });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ status: 'error', message: error.message });
  }
});

app.post('/googlesheet/restart', async (req, res) => {
  try {
    const response = await axios.post('https://googlesheet-dd00.onrender.com/restart', {}, { timeout: 60000 });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ status: 'error', message: error.message });
  }
});

// -------------------------------------------------------------
// Error handler middleware
app.use(errorHandler);

// Initialize stock_mapping table on startup
try {
  await initializeStockMapping();
} catch (err) {
  console.error('[Startup] Error during initialization:', err);
}

// -------------------------------------------------------------
// Start the server
const server = app.listen(PORT, () => {
console.log(`🚀 Server running on port ${PORT}`);
  
  // Initialize Angel Live Prices
  try {
    initLivePriceServer(server);
    loginToAngel();
    startAngelOneService();
    initNSEIndexUpdater();
    // Clean up old broker_orders and schedule daily cleanup
    startBrokerOrdersCleanup();
    startOrderTracker();
    initCasAutomation(cron);
    initAmfiNavService();
    initializeZerodhaScheduler();
    initMaintenanceService();
    initializeCASScheduler();
  } catch (err) {
    console.error('[Angel] Error initializing live prices:', err);
  }

  // 🕒 Corporate Action Sync - Scheduled (9:00 AM and 9:00 PM)
  cron.schedule('0 9,21 * * *', () => {
    console.log('⏰ [Cron] Triggering Corporate Action Sync...');
    startCorpActionService();
  });

  // 🕒 Angel One Price Fix - Scheduled (Every 6 hours)
  cron.schedule('0 */6 * * *', () => {
    console.log('⏰ [Cron] Triggering Angel One Price Fix Service...');
    runAngelPriceFixService();
  });
});
