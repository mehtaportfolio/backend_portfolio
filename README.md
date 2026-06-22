# Portfolio Tracker Backend Server

Backend service for the portfolio tracker application. Handles data aggregation, caching, and expensive computations (FIFO lot tracking, XIRR, aggregations).

## Quick Start

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Setup Environment

Copy `.env.backend` and fill in your Supabase credentials:

```bash
cp .env.backend .env.backend.local
# Edit .env.backend.local with your values
```

Required variables:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `CORS_ORIGIN` - Frontend origin (e.g., `http://localhost:3000`)

### 3. Run Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

Server runs on `http://localhost:3001` by default.

---

## Architecture

### Project Structure

```
backend/
├── src/
│   ├── index.js                    # Express app entry point
│   │
│   ├── routes/
│   │   └── dashboard.js            # Dashboard endpoints
│   │
│   ├── services/
│   │   ├── dashboardService.js     # Dashboard aggregation logic
│   │   ├── lotCalculator.js        # FIFO lot tracking (stocks, MF)
│   │   └── aggregationService.js   # Asset type calculations
│   │
│   ├── db/
│   │   └── queries.js              # Supabase query helpers
│   │
│   └── middleware/
│       ├── cache.js                # In-memory caching
│       ├── auth.js                 # JWT verification
│       └── errorHandler.js         # Error handling
│
├── package.json
└── .env.backend                    # Configuration template
```

### Caching Strategy

**In-Memory Cache** (TTL-based):
- Dashboard summary: **5 minutes** (default)
- Asset holdings: **10 minutes**
- Chart data: **15 minutes**

Cache automatically invalidates after TTL. No external Redis needed.

```javascript
// Cached GET requests are automatically stored
GET /api/dashboard/asset-allocation
// Response includes: X-Cache: HIT or X-Cache: MISS
```

---

## API Endpoints

### Dashboard

#### `GET /api/dashboard/asset-allocation`

Returns asset-wise breakdown with market values, invested amounts, and P&L.

**Query Parameters:**
- `userId` (optional) - User ID (currently hardcoded for testing)

**Response:**
```json
{
  "success": true,
  "data": {
    "rows": [
      {
        "assetType": "Stock",
        "marketValue": 500000,
        "investedValue": 400000,
        "simpleProfit": 100000,
        "simpleProfitPercent": 25,
        "marketAllocation": 45.5,
        "investedAllocation": 50.2
      },
      // ... other asset types
    ],
    "summary": {
      "totalMarketValue": 1100000,
      "totalInvestedValue": 800000,
      "totalProfit": 300000,
      "profitPercent": 37.5
    },
    "timestamp": "2024-01-15T10:30:00Z"
  },
  "cache": "HIT"
}
```

#### `GET /api/dashboard/summary`

Quick portfolio summary (no asset details).

**Response:**
```json
{
  "success": true,
  "data": {
    "totalMarketValue": 1100000,
    "totalInvestedValue": 800000,
    "totalProfit": 300000,
    "profitPercent": 37.5
  },
  "cache": "MISS"
}
```

#### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

---

## Core Services

### `dashboardService.js`

Orchestrates asset allocation computation:

```javascript
import { getDashboardAssetAllocation } from './services/dashboardService.js';

const result = await getDashboardAssetAllocation(supabase, userId);
// Returns: { rows: [...], summary: {...}, timestamp: ... }
```

**Process:**
1. Fetch all user data tables in parallel
2. Build CMP maps from master tables
3. Calculate each asset type:
   - Stock & ETF (FIFO lots)
   - Mutual Funds (FIFO lots)
   - Bank, PPF, EPF, NPS
   - FD (placeholder)
4. Aggregate totals and allocations
5. Cache result (5 min TTL)

### `lotCalculator.js`

FIFO lot tracking for stocks and mutual funds:

```javascript
import { calculateStockLots, calculateMFLots } from './services/lotCalculator.js';

const stockData = calculateStockLots(transactions, cmpMap);
// Returns: { stock: {...}, etf: {...}, holdings: [...] }

const mfData = calculateMFLots(transactions, cmpMap);
// Returns: { marketValue, invested, holdings: [...] }
```

**Features:**
- FIFO lot tracking (first-in, first-out)
- Handles buy, sell, redeem, switch transactions
- Calculates P&L per holding

### `aggregationService.js`

Calculates holdings for each asset type:

- `calculateStockLots()` - Stock & ETF holdings
- `calculateMFLots()` - Mutual fund holdings
- `calculateBankHoldings()` - Latest month savings/demat
- `calculatePPFHoldings()` - PPF invested + interest
- `calculateEPFHoldings()` - EPF contributions + interest
- `calculateNPSHoldings()` - NPS portfolio with lots
- `calculateFDHoldings()` - FD placeholder

---

## Database Queries

### `db/queries.js`

Reusable query helpers:

```javascript
import { fetchAllRows, batchFetchTables, fetchUserAllData } from './db/queries.js';

// Fetch single table
const { data, error } = await fetchAllRows(supabase, 'stock_transactions', {
  select: 'stock_name, quantity, buy_price',
  limit: 1000,
});

// Batch fetch multiple tables
const results = await batchFetchTables(supabase, {
  stock_transactions: { select: '...' },
  stock_master: { select: '...' },
});

// Fetch all user data (combines 9 tables)
const data = await fetchUserAllData(supabase, userId);
```

---

## Caching System

### In-Memory Cache

Located in `middleware/cache.js`:

```javascript
import cache, { cacheMiddleware } from './middleware/cache.js';

// Manual cache operations
cache.set('key', data, ttlMinutes);
const value = cache.get('key');
cache.delete('key');
cache.clear();

// Stats
const { size, keys } = cache.stats();
```

### HTTP Caching Middleware

Auto-caches GET responses:

```javascript
// 5-minute cache for all requests to this route
router.get('/endpoint', cacheMiddleware(5), async (req, res) => {
  // Response automatically cached
  res.json(data);
});
```

**Headers:**
- `X-Cache: HIT` - Response from cache
- `X-Cache: MISS` - Response from backend

---

## Deployment

### Render

1. **Create new Web Service** in Render dashboard
2. **Connect GitHub repo**
3. **Set environment variables:**
   ```
   PORT=3001
   SUPABASE_URL=...
   SUPABASE_ANON_KEY=...
   CORS_ORIGIN=https://your-frontend.com
   ```
4. **Build command:** `npm install`
5. **Start command:** `npm start`

### Local Testing

```bash
# Terminal 1: Backend
cd backend
npm run dev
# http://localhost:3001

# Terminal 2: Frontend
npm start
# http://localhost:3000
```

---

## Performance Metrics

### Expected Load Times (Cached)

| Endpoint | First Call | Cached Call |
|----------|-----------|-------------|
| `/api/dashboard/asset-allocation` | 800ms - 1.2s | 5-10ms |
| `/api/dashboard/summary` | 800ms - 1s | 5-10ms |

### Performance Improvements

| Metric | Before | After |
|--------|--------|-------|
| Initial Dashboard Load | 3-5s (9 queries) | 500-800ms (1 query) |
| Dashboard Re-render | Recalculates | Instant (cached) |
| Memory Usage | High (browser) | Low (only view data) |

---

## Common Tasks

### Add New Endpoint

1. Create route in `src/routes/`
2. Implement service logic in `src/services/`
3. Register in `src/index.js`
4. Add caching as needed

### Adjust Cache TTL

Edit `.env.backend`:
```
CACHE_TTL_DASHBOARD=5        # 5 minutes
CACHE_TTL_ASSETS=10          # 10 minutes
CACHE_TTL_CHARTS=15          # 15 minutes
```

### Force Cache Invalidation

```javascript
// In service before computation
import cache from '../middleware/cache.js';
cache.delete('relevant:cache:key');
```

---

## Troubleshooting

### CORS Errors

**Issue:** Frontend can't reach backend
```
Access to XMLHttpRequest blocked by CORS policy
```

**Solution:**
1. Ensure `CORS_ORIGIN` in `.env.backend` matches frontend URL
2. Frontend should be running on correct port (default: 3000)
3. Use full URLs: `http://localhost:3001` (not relative paths)

### No Data Returned

**Check:**
1. Supabase credentials valid? → Test with health endpoint
2. Database has data? → Query Supabase directly
3. User ID correct? → Check logs for user ID

### Slow Response

**Check:**
1. Is cache working? → Look for `X-Cache: HIT` header
2. Supabase network latency? → Check Supabase status
3. Browser dev tools → Network tab for request times

---

## Next Phases

1. **Stock Portfolio** - Migrate asset page to `/api/stock/portfolio`
2. **Chart Endpoints** - Pre-process chart data server-side
3. **Analysis Pages** - Aggregate growth, yearly P&L data
4. **Real-time Updates** - WebSocket support for live data (optional)

---

## Environment Variables Reference

```bash
# Server
PORT=3001                          # Server port
NODE_ENV=development|production    # Environment

# Supabase
SUPABASE_URL=...                   # Project URL
SUPABASE_ANON_KEY=...              # Anonymous key
SUPABASE_SERVICE_KEY=...           # (Optional) Service key for admin ops

# Caching (in minutes)
CACHE_TTL_DASHBOARD=5              # Dashboard summary
CACHE_TTL_ASSETS=10                # Asset holdings
CACHE_TTL_CHARTS=15                # Chart data

# CORS
CORS_ORIGIN=http://localhost:3000  # Frontend origin

# Real-time
ENABLE_REAL_TIME_SYNC=false        # Enable WebSocket syncing
SYNC_INTERVAL_MS=300000            # Sync interval (5 min default)
```

---

## Support

For issues or questions:
1. Check logs: `npm run dev` shows detailed logs
2. Enable debug: Add `DEBUG=*` before npm command
3. Check Supabase connection
4. Review cache status: Add `/cache-stats` endpoint if needed

---

**Last Updated:** 2024
**Version:** 1.0.0