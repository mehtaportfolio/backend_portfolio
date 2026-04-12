// ✅ Polyfill browser-only objects for pdfjs-dist in Node environment
if (typeof global.window === 'undefined') {
  global.window = global;
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
import errorHandler from './middleware/errorHandler.js';
import authMiddleware from './middleware/auth.js';
import cacheMiddleware from './middleware/cache.js';

// -------------------------------------------------------------
// Initialize Express app
const app = express();

// Simple request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
const PORT = process.env.PORT || 3001;

// -------------------------------------------------------------
// Global Middleware
const rawCorsOrigins = process.env.CORS_ORIGIN || 'http://localhost:3000';
const allowedOrigins = rawCorsOrigins
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
      const match = allowedOrigins.some((o) => origin.startsWith(o));
      if (match) return callback(null, true);
      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json());

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
const { default: dashboardRoutes } = await import('./routes/dashboard.js');
const { default: analysisRoutes } = await import('./routes/analysis.js');
const { default: assetsRoutes } = await import('./routes/assets.js');
const { default: stockRoutes } = await import('./routes/stocks.js');
const { default: schemesRoutes } = await import('./routes/schemes.js');
const { default: cacheRoutes } = await import('./routes/cache.js');
const { default: notificationRoutes } = await import('./routes/notifications.js');
const { default: dividendRoutes } = await import('./routes/dividend.js');
const { default: fundsRoutes } = await import('./routes/funds.js');
const { default: casRoutes } = await import('./routes/cas.js');
const { default: zerodhaRoutes } = await import('./routes/zerodha.js');
const { sendAngelOneStatusNotification } = await import('./services/notificationService.js');
const { initializeStockMapping } = await import('./db/initStockMapping.js');

// Attach routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/schemes', schemesRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dividend', dividendRoutes);
app.use('/funds', fundsRoutes);
app.use('/api/cas', casRoutes);
app.use('/api/zerodha', zerodhaRoutes);

// ✅ Add direct kite callback route (Zerodha's expected redirect URL)
const { zerodhaCallback } = await import('./services/zerodhaService.js');
app.get('/kite/callback', zerodhaCallback);

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

// ✅ Add Angel One status route
app.post('/api/angel-one-status', async (req, res, next) => {
  try {
    const { success, message, timestamp, authenticated } = req.body;
    
    await sendAngelOneStatusNotification({ success, message, timestamp, authenticated });
    
    res.json({ status: 'success', message: 'Notification sent' });
  } catch (err) {
    next(err);
  }
});

// 🔹 Proxy endpoint for Render service deployment/restart
app.post('/api/render/deploy', async (req, res) => {
  const { serviceId, apiKey, clearCache = 'clear' } = req.body;

  if (!serviceId) {
    return res.status(400).json({ status: 'error', message: 'serviceId is required' });
  }

  // Use provided apiKey or fallback to environment variable
  const token = apiKey || process.env.RENDER_API_KEY;

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Render API key is missing' });
  }

  try {
    const response = await axios.post(
      `https://api.render.com/v1/services/${serviceId}/deploys`,
      { clearCache },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }
      }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`❌ Error triggering Render deploy for ${serviceId}:`, error.message);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.response?.data?.message || error.message || 'Failed to trigger Render deploy',
      error: error.response?.data
    });
  }
});

// 🔹 Proxy endpoints for Angel One services
app.get('/api/angel-one-health', async (req, res) => {
  try {
    const response = await axios.get('https://mehta-ao-prices.onrender.com/health', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    res.json({
      status: 'success',
      message: 'Angel One server is healthy',
      data: response.data
    });
  } catch (error) {
    console.error('❌ Error calling Angel One health check:', error.message);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.message || 'Failed to reach Angel One server',
      error: error.response?.data || error.message
    });
  }
});

app.get('/refresh-stocks', async (req, res) => {
  try {
    const response = await axios.get('https://mehta-ao-prices.onrender.com/refresh-stocks', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    res.json({
      status: 'success',
      message: response.data?.message || 'Angel One stock list refreshed successfully',
      data: response.data
    });
  } catch (error) {
    console.error('❌ Error calling Angel One refresh-stocks:', error.message);
    console.error('Error details:', error.response?.status, error.response?.data);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.message || 'Failed to refresh Angel One stock list',
      error: error.response?.data || error.message
    });
  }
});

app.post('/sync-cmp', async (req, res) => {
  try {
    const response = await axios.get('https://mehta-ao-prices.onrender.com/sync-cmp', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    res.json({
      status: 'success',
      message: response.data?.message || 'CMP sync triggered successfully',
      data: response.data
    });
  } catch (error) {
    console.error('❌ Error calling CMP sync:', error.message);
    console.error('Error details:', error.response?.status, error.response?.data);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.message || 'Failed to trigger CMP sync',
      error: error.response?.data || error.message
    });
  }
});

app.post('/sync-lcp', async (req, res) => {
  try {
    const response = await axios.get('https://mehta-ao-prices.onrender.com/sync-lcp', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    res.json({
      status: 'success',
      message: response.data?.message || 'LCP sync triggered successfully',
      data: response.data
    });
  } catch (error) {
    console.error('❌ Error calling LCP sync:', error.message);
    console.error('Error details:', error.response?.status, error.response?.data);
    res.status(error.response?.status || 500).json({
      status: 'error',
      message: error.message || 'Failed to trigger LCP sync',
      error: error.response?.data || error.message
    });
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

app.post('/yahoo-price/trigger', async (req, res) => {
  try {
    // Yahoo Price might be a GET or POST depending on how it's implemented
    const response = await axios.get('https://stock-yahoo-allq.onrender.com', { timeout: 60000 });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ status: 'error', message: error.message });
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
app.listen(PORT, () => {
console.log(`🚀 Server running on port ${PORT}`);
});
