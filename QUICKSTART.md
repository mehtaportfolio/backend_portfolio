# Quick Start Guide - Backend Server

Get the backend running in 5 minutes ⚡

---

## Prerequisites

- Node.js 18+ installed
- Supabase project with credentials
- Backend folder cloned (already done ✅)

---

## 🚀 5-Minute Setup

### Step 1: Install Dependencies (1 min)

```bash
cd backend
npm install
```

### Step 2: Configure Environment (1 min)

```bash
# Copy template
cp .env.backend .env.backend.local
```

Edit `backend/.env.backend.local`:
```bash
# Get these from Supabase dashboard (Settings → API)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here

# Leave as-is for local development
PORT=3001
CORS_ORIGIN=http://localhost:3000
CACHE_TTL_DASHBOARD=5
```

### Step 3: Start Server (1 min)

```bash
npm run dev
```

You should see:
```
✅ Portfolio Tracker Backend running on http://localhost:3001
📊 Dashboard API: http://localhost:3001/api/dashboard/asset-allocation
🏥 Health check: http://localhost:3001/health
```

### Step 4: Test It (1 min)

In browser or terminal:

```bash
# Health check
curl http://localhost:3001/health

# Get dashboard data
curl http://localhost:3001/api/dashboard/asset-allocation
```

### Step 5: Connect Frontend (1 min)

In frontend `.env`:
```
REACT_APP_API_BASE=http://localhost:3001
```

Restart frontend:
```bash
npm start
```

✅ **Done! Backend is running and connected.**

---

## 🎯 Verify It Works

### In Browser DevTools (Network tab)

1. Open `http://localhost:3000`
2. Go to Network tab
3. Load Dashboard
4. Should see: `api/dashboard/asset-allocation`
5. Response should have data: `rows`, `summary`

### Check Cache

Response headers:
- **First request:** `X-Cache: MISS`
- **Next 5 minutes:** `X-Cache: HIT`

⚡ That's the caching working!

---

## 📂 Project Structure

```
backend/
├── src/
│   ├── index.js                    ← Server entry point
│   ├── routes/
│   │   └── dashboard.js            ← Dashboard endpoints
│   ├── services/
│   │   ├── dashboardService.js     ← Business logic
│   │   ├── lotCalculator.js        ← FIFO tracking
│   │   └── aggregationService.js   ← Asset calculations
│   ├── db/
│   │   └── queries.js              ← Database helpers
│   └── middleware/
│       ├── cache.js                ← Caching (5-min TTL)
│       ├── auth.js                 ← Auth (JWT)
│       └── errorHandler.js         ← Error handling
├── package.json
├── .env.backend                    ← Config
└── README.md                       ← Full docs
```

---

## 🔌 API Endpoints

### `GET /api/dashboard/asset-allocation`

Returns asset allocation with market values, invested, profits:

```bash
curl http://localhost:3001/api/dashboard/asset-allocation
```

Response:
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
        "marketAllocation": 45.5
      }
    ],
    "summary": {
      "totalMarketValue": 1100000,
      "totalInvestedValue": 800000,
      "totalProfit": 300000
    }
  },
  "cache": "MISS"
}
```

### `GET /api/dashboard/summary`

Quick summary only:

```bash
curl http://localhost:3001/api/dashboard/summary
```

### `GET /health`

Health check:

```bash
curl http://localhost:3001/health
```

---

## 🛠️ Common Tasks

### Adjust Cache TTL

Edit `.env.backend.local`:
```bash
CACHE_TTL_DASHBOARD=2  # 2 minutes instead of 5
```

Restart backend.

### View Logs

```bash
npm run dev
# Shows all requests and cache hits/misses
```

### Test Without Database

```bash
# Backend returns empty arrays if no Supabase connection
# Still works, just no data
```

### Restart Server

```bash
# Press Ctrl+C
# Run again:
npm run dev
```

---

## ⚙️ Troubleshooting

### "Cannot find module" Error

```bash
# Run npm install again
npm install

# Clear cache
npm cache clean --force
npm install
```

### CORS Errors in Frontend

```bash
# Update .env.backend.local:
CORS_ORIGIN=http://localhost:3000

# Restart backend
# Clear browser cache
```

### "Connection refused" Error

```bash
# Supabase credentials wrong?
# Backend can't reach Supabase?
# Edit .env.backend.local with correct URL and key
```

### Port 3001 Already in Use

```bash
# Use different port:
PORT=3002 npm run dev

# Or kill process using port 3001:
# Windows: taskkill /PID {pid} /F
# Mac/Linux: kill -9 {pid}
```

### No Data Returned

```bash
# Check Supabase has data
# Check credentials in .env.backend.local
# Check logs for errors: npm run dev
```

---

## 📚 Next Steps

1. **Update Dashboard component** - See `FRONTEND_INTEGRATION.md`
2. **Deploy to Render** - See `RENDER_DEPLOYMENT.md`
3. **Add more endpoints** - See `README.md` (Services section)
4. **Optimize further** - See `README.md` (Performance section)

---

## 📖 Full Documentation

- **Architecture & APIs:** `README.md`
- **Frontend Integration:** `FRONTEND_INTEGRATION.md`
- **Production Deployment:** `RENDER_DEPLOYMENT.md`

---

## ✅ Checklist

- [ ] Node.js 18+ installed
- [ ] Supabase credentials obtained
- [ ] `.env.backend.local` configured
- [ ] `npm install` ran successfully
- [ ] Server starts: `npm run dev`
- [ ] Health endpoint responds
- [ ] Dashboard endpoint returns data
- [ ] Frontend connected (`REACT_APP_API_BASE` set)
- [ ] Dashboard tab shows data

---

## 🎉 You're Ready!

Backend is running with:
- ✅ In-memory caching (5-min TTL)
- ✅ Fast dashboard data (800ms)
- ✅ Production-ready code
- ✅ Easy frontend integration

**Next:** Follow `FRONTEND_INTEGRATION.md` to update Dashboard component.

---

## 💡 Pro Tips

1. **Keep backend running** - Use `npm run dev` for local development
2. **Check logs** - They show cache hits/misses
3. **Monitor DevTools** - See Network requests and response times
4. **Test endpoints** - Use browser or `curl` to test APIs
5. **Cache debugging** - Add `X-Cache` header to response checks

---

## 🆘 Need Help?

1. **Check logs:** `npm run dev` output
2. **Read docs:** `README.md` has detailed sections
3. **Browser DevTools:** Network tab shows what's happening
4. **Supabase status:** Check database is accessible
5. **Restart everything:** Sometimes that fixes it! 😄

---

**Happy coding! 🚀**