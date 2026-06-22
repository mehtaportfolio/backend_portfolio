# Render Deployment Guide

Deploy the backend server to Render for production use.

## Prerequisites

- Render account (free tier available)
- GitHub repository with backend code
- Supabase project with credentials

---

## Step 1: Prepare Repository

1. **Ensure backend folder is in root:**
   ```
   c:/portfolio-tracker/
   ├── backend/
   │   ├── src/
   │   ├── package.json
   │   └── .env.backend
   ├── src/  (frontend)
   └── ...
   ```

2. **Create `.gitignore` in backend folder:**
   ```bash
   node_modules/
   .env.backend.local
   .DS_Store
   *.log
   ```

3. **Ensure `package.json` has correct start command:**
   ```json
   {
     "scripts": {
       "start": "node src/index.js"
     }
   }
   ```

---

## Step 2: Create Render Service

### 2a. Go to Render Dashboard

1. Visit https://dashboard.render.com
2. Click **"New +"** → **"Web Service"**
3. Select **"Build and deploy from a Git repository"**

### 2b. Connect GitHub

1. Connect your GitHub account
2. Select portfolio-tracker repository
3. Choose **branch**: `main` or `develop`

### 2c. Configure Service

**Basic Settings:**

| Setting | Value |
|---------|-------|
| **Name** | `portfolio-tracker-backend` |
| **Environment** | `Node` |
| **Region** | Choose closest to you |
| **Branch** | `main` |

**Build & Deploy:**

| Setting | Value |
|---------|-------|
| **Root Directory** | `backend` |
| **Build Command** | `./render-build.sh` |
| **Start Command** | `npm start` |

---

## Step 3: Environment Variables

In Render dashboard, go to **Environment** tab and add:

```env
PORT=3001
NODE_ENV=production

SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_key

CACHE_TTL_DASHBOARD=5
CACHE_TTL_ASSETS=10
CACHE_TTL_CHARTS=15

CORS_ORIGIN=https://your-frontend-domain.com
```

**Where to find Supabase credentials:**
1. Go to Supabase dashboard
2. Settings → API
3. Copy `Project URL` and `anon key`

---

## Step 4: Deploy

1. Click **"Create Web Service"**
2. Render automatically deploys from Git
3. Watch build logs in **"Logs"** tab
4. Once complete, you'll get a URL: `https://your-service.onrender.com`

---

## Step 5: Update Frontend

Update frontend to use production backend:

**`public/.env.production`:**
```
REACT_APP_API_BASE=https://your-service.onrender.com
```

---

## Step 6: Test

1. Check backend health:
   ```
   https://your-service.onrender.com/health
   ```

2. Test dashboard endpoint:
   ```
   https://your-service.onrender.com/api/dashboard/asset-allocation
   ```

3. Should return:
   ```json
   {
     "success": true,
     "data": { ... },
     "cache": "MISS"
   }
   ```

---

## Production Checklist

- [ ] Environment variables set in Render
- [ ] Supabase credentials correct
- [ ] CORS_ORIGIN set to frontend domain
- [ ] Backend health endpoint responds
- [ ] Dashboard API returns data
- [ ] Frontend can connect to backend
- [ ] Cache headers present (X-Cache: HIT/MISS)
- [ ] SSL certificate active (Render provides free SSL)

---

## Monitoring

### View Logs
- Dashboard → **Logs** tab
- See real-time server activity

### Common Issues

**SSL Certificate Errors:**
```
AxiosError: unable to get local issuer certificate
```
- This can happen if the target server (e.g., AMFI) has an incomplete certificate chain.
- If it persists, you can set `NODE_TLS_REJECT_UNAUTHORIZED=0` in Render Environment Variables (Note: This disables SSL verification globally for the service, use with caution).
- Alternatively, the code can be updated to use a custom HTTPS agent for specific domains.

**Puppeteer Chrome Missing:**
```
Could not find Chrome (ver. 147.0.7727.57)
```
- Ensure you are using `./render-build.sh` as the **Build Command** in Render settings.
- This script runs `npx puppeteer browsers install chrome` to ensure the browser is available in the Render environment.

**Service Not Starting:**
```
Cannot find executable node
```
- Ensure Node environment selected
- Check start command: `npm start`

**CORS Errors:**
```
Access to XMLHttpRequest blocked
```
- Verify CORS_ORIGIN matches frontend domain
- Restart service

**No Data Returned:**
```
Cannot query database
```
- Check Supabase credentials
- Ensure database is accessible
- Check Supabase status page

---

## Auto-Redeploy

Render automatically redeploys on Git push:

1. **Make changes** locally
2. **Push to GitHub:**
   ```bash
   git add .
   git commit -m "Update backend"
   git push origin main
   ```
3. **Render detects** push and redeploys
4. **Watch logs** for deployment progress

---

## Environment-Specific Configuration

### Development
```env
NODE_ENV=development
CACHE_TTL_DASHBOARD=1
```

### Production
```env
NODE_ENV=production
CACHE_TTL_DASHBOARD=5
ENABLE_REAL_TIME_SYNC=false
```

---

## Performance Optimization

### 1. Enable Persistent Disk (Optional)

If you need persistent storage:
1. Dashboard → **Disks**
2. **Add Disk** → Choose size
3. Mount at `/var/data`

### 2. Scale Plan (Optional)

For higher traffic:
1. Dashboard → **Pricing**
2. Upgrade to **Standard or Premium** plan
3. Get dedicated resources

### 3. Auto-Scale (Not Available on Free)

Free tier: Manual scaling only
- Scale up for high traffic periods
- Scale down when not needed

---

## Custom Domain

To use your own domain:

1. **In Render dashboard:**
   - Service Settings → **Custom Domain**
   - Enter domain: `api.your-domain.com`

2. **Update DNS:**
   - Add CNAME record:
     ```
     api.your-domain.com → your-service.onrender.com
     ```

3. **Wait 24-48 hours** for DNS propagation

4. **Update frontend:**
   ```env
   REACT_APP_API_BASE=https://api.your-domain.com
   ```

---

## Troubleshooting

### 1. Service keeps crashing

**Check logs:**
```
Dashboard → Logs → Look for errors
```

**Common causes:**
- Missing environment variables
- Node version mismatch
- Supabase down/credentials wrong

**Fix:**
```bash
# Test locally first
npm run dev

# Check all env vars set
echo $SUPABASE_URL

# Push fixed code
git push
```

### 2. Slow response times

**Check:**
- Cache TTL too high? Lower to 2-3 min
- Supabase slow? Check Supabase status
- Query too complex? Profile in backend logs

**Enable request logging:**
```bash
# In backend logs, add timestamps
console.log(`[${new Date().toISOString()}] Request...`);
```

### 3. Deployment stuck

**Try:**
1. Manual redeploy: Dashboard → **Manual Deploy** → **Latest** → **Deploy**
2. Check build logs for errors
3. Verify package.json syntax

---

## Cost Estimation (Free Tier)

| Resource | Free Tier | Included |
|----------|-----------|----------|
| **Web Service** | Yes | 1 service |
| **Database** | No | - |
| **Auto-wake** | No | - |
| **Storage** | - | No disk |
| **Bandwidth** | - | Limited |

**Free tier restart:** Service suspends after 15 min of inactivity, restarts on request (cold start ~20s)

---

## Upgrade Plan

If free tier isn't enough:

1. Dashboard → **Pricing**
2. Select **Standard** or **Premium**
3. Add payment method
4. Auto-scales on demand

---

## Rollback

If deployment has issues:

1. **In Render dashboard:**
   - Service → **Deploy** tab
   - Find previous deployment
   - Click **Rollback** or **Redeploy**

2. **Or via Git:**
   ```bash
   git revert <commit>
   git push
   ```

---

## Monitoring & Alerts

### Set Up Notifications

1. Dashboard → **Notifications**
2. Add email alerts for:
   - Build failures
   - Service crashes
   - Error threshold exceeded

### Check Status

Render status page: https://status.render.com

---

## Production Best Practices

1. ✅ Use `NODE_ENV=production`
2. ✅ Set strong random `CORS_ORIGIN`
3. ✅ Keep Supabase keys in environment variables (never commit)
4. ✅ Enable request logging for debugging
5. ✅ Monitor error rates in logs
6. ✅ Set up auto-deployment for CI/CD
7. ✅ Regular backups of Supabase data
8. ✅ Test new changes on staging first

---

## Support

**Render Support:**
- https://render.com/support
- Email: support@render.com

**Backend Issues:**
- Check backend README.md
- Review logs in Render dashboard
- Test locally with `npm run dev`

---

## Quick Reference

**Service URL:** `https://portfolio-tracker-backend.onrender.com`
**Health Check:** `https://portfolio-tracker-backend.onrender.com/health`
**Dashboard API:** `https://portfolio-tracker-backend.onrender.com/api/dashboard/asset-allocation`

---

**Deployment complete! Your backend is now live on Render.**