// ✅ Load environment variables FIRST (before anything else)
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve .env.backend path (one level up from src/)
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.backend');
dotenv.config({ path: envPath, override: false });

// Debug check – ensure .env loaded
console.log('✅ Loaded SUPABASE_URL:', process.env.SUPABASE_URL || '❌ Missing');

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

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// -------------------------------------------------------------
// Root routes for Render keep-alive and restart simulation
app.get('/', (req, res) => {
  res.json({ status: 'backend up', timestamp: new Date().toISOString() });
});

app.post('/', (req, res) => {
  // Simulate restart request (Render free tier doesn't support API restarts)
  console.log('Restart request received');
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
// ✅ Dynamically import routes AFTER dotenv is loaded
const { default: dashboardRoutes } = await import('./routes/dashboard.js');
const { default: analysisRoutes } = await import('./routes/analysis.js');
const { default: assetsRoutes } = await import('./routes/assets.js');
const { default: stockRoutes } = await import('./routes/stocks.js');
const { default: schemesRoutes } = await import('./routes/schemes.js');
const { default: cacheRoutes } = await import('./routes/cache.js');
const { default: notificationRoutes } = await import('./routes/notifications.js');

// Attach routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/schemes', schemesRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/notifications', notificationRoutes);

// 🔹 Proxy endpoints for Angel One services
app.get('/refresh-stocks', async (req, res) => {
  try {
    console.log('🔄 Calling Angel One refresh-stocks endpoint...');
    const response = await axios.get('https://mehta-ao-prices.onrender.com/refresh-stocks', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('✅ Angel One refresh-stocks response:', response.data);
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
    console.log('🔄 Triggering CMP sync...');
    const response = await axios.get('https://mehta-ao-prices.onrender.com/sync-cmp', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('✅ CMP sync response:', response.data);
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
    console.log('🔄 Triggering LCP sync...');
    const response = await axios.get('https://mehta-ao-prices.onrender.com/sync-lcp', {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('✅ LCP sync response:', response.data);
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

// -------------------------------------------------------------
// Error handler middleware
app.use(errorHandler);

// -------------------------------------------------------------
// Start the server
app.listen(PORT, () => {
  console.log(`\n✅ Portfolio Tracker Backend running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard API: http://localhost:${PORT}/api/dashboard/asset-allocation`);
  console.log(`📈 Analysis Dashboard: http://localhost:${PORT}/api/analysis/dashboard`);
  console.log(`📋 Analysis Summary: http://localhost:${PORT}/api/analysis/summary`);
  console.log(`📊 Free Stocks: http://localhost:${PORT}/api/analysis/free-stocks`);
  console.log(`📈 Stock - Open Holdings: http://localhost:${PORT}/api/stock/open`);
  console.log(`📈 Stock - Closed Holdings: http://localhost:${PORT}/api/stock/closed`);
  console.log(`📈 Stock - ETF: http://localhost:${PORT}/api/stock/etf`);
  console.log(`📈 Stock - Portfolio: http://localhost:${PORT}/api/stock/portfolio`);
  console.log(`🏦 Assets - Bank: http://localhost:${PORT}/api/assets/bank`);
  console.log(`🏦 Assets - NPS: http://localhost:${PORT}/api/assets/nps`);
  console.log(`🏦 Assets - BDM: http://localhost:${PORT}/api/assets/bdm`);
  console.log(`🏦 Assets - EPF: http://localhost:${PORT}/api/assets/epf`);
  console.log(`🏦 Assets - PPF: http://localhost:${PORT}/api/assets/ppf`);
  console.log(`💰 Assets - MF: http://localhost:${PORT}/api/assets/mf`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health\n`);
});
