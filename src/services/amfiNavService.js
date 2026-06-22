import axios from 'axios';
import https from 'https';
import cron from 'node-cron';
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows, insertRows, upsertRows, deleteRows } from '../db/queries.js';

/**
 * AMFI NAV Service
 * Fetches latest NAV from AMFI and stores history in fund_master_backend
 * Keeps only 7 days of data.
 */

const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";

export async function initAmfiNavService() {
  console.log('Initializing AMFI NAV Service...');
  
  // Schedule: 8:00 AM and 8:00 PM daily
  cron.schedule('0 8,20 * * *', async () => {
    const now = new Date();
    const is8PM = now.getHours() === 20;
    console.log(`[${now.toISOString()}] Running Scheduled AMFI NAV Update...`);
    
    try {
      const stats = await updateAllFundsNAV();
      
      // If it's 8 PM and no new data was found (stats.updated === 0), try again in 2 hours
      if (is8PM && stats && stats.updated === 0) {
        console.log('No new NAV data found at 8 PM. Scheduling retry in 2 hours (approx 10 PM)...');
        
        // Schedule a one-off retry 2 hours from now
        const retryTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const m = retryTime.getMinutes();
        const h = retryTime.getHours();
        const d = retryTime.getDate();
        const mo = retryTime.getMonth() + 1;
        
        const retryCron = `${m} ${h} ${d} ${mo} *`;
        const retryTask = cron.schedule(retryCron, async () => {
          console.log(`[${new Date().toISOString()}] Running Retry AMFI NAV Update...`);
          await updateAllFundsNAV();
          retryTask.stop(); // Run only once
        });
      }
    } catch (error) {
      console.error('Scheduled AMFI NAV Update Failed:', error);
    }
  });

  console.log('AMFI NAV Service Scheduled (8 AM & 8 PM)');
}

export async function updateAllFundsNAV() {
  const stats = { total: 0, found: 0, updated: 0, skipped: 0, errors: 0 };
  try {
    // 1. Fetch latest NAV data from AMFI
    let response;
    try {
      response = await axios.get(AMFI_URL, { timeout: 30000 });
    } catch (err) {
      if (err.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || err.message?.includes('certificate')) {
        console.warn('⚠️ SSL certificate error for AMFI, retrying with rejectUnauthorized: false...');
        const agent = new https.Agent({ rejectUnauthorized: false });
        response = await axios.get(AMFI_URL, { timeout: 30000, httpsAgent: agent });
      } else {
        throw err;
      }
    }
    const amfiText = response.data;
    const navMap = parseAmfiText(amfiText);
    
    // 2. Fetch templates (unique metadata) from our database
    const { data: rawFunds, error: fetchError } = await fetchAllRows(supabase, 'fund_master_backend', {
      select: 'isin, scheme_code, fund_short_name, amc_name, fund_full_name, category, last_sync_at',
      order: { column: 'last_sync_at', ascending: false }
    });
      
    if (fetchError) throw fetchError;
    if (!rawFunds || rawFunds.length === 0) {
      console.log('No funds found in fund_master_backend to update.');
      return stats;
    }

    // Deduplicate by ISIN to get the latest metadata template for each fund
    const templates = new Map();
    for (const f of rawFunds) {
      if (!templates.has(f.isin)) {
        templates.set(f.isin, f);
      }
    }

    stats.total = templates.size;
    console.log(`Processing ${templates.size} unique funds from AMFI data...`);

    const newEntries = [];
    const now = new Date().toISOString();

    for (const [isin, fund] of templates) {
      const schemeCode = String(fund.scheme_code).trim();
      const amfiData = navMap.get(schemeCode);

      if (amfiData) {
        stats.found++;
        const rawNav = amfiData.nav;
        const newNav = parseFloat(rawNav);
        const amfiDateStr = parseAmfiDate(amfiData.date);

        // ENSURE: Only insert if NAV is a valid positive number (not NaN, not null, not undefined, and > 0)
        const isValidNav = !isNaN(newNav) && newNav > 0 && String(rawNav).toLowerCase() !== 'n.a.';

        if (isValidNav && amfiDateStr) {
          const amfiIsoDate = new Date(amfiDateStr).toISOString();
          const lastSyncDate = fund.last_sync_at ? new Date(fund.last_sync_at).toISOString() : null;

          // Only insert if this date is newer than what we have for this ISIN
          if (!lastSyncDate || amfiIsoDate > lastSyncDate) {
            newEntries.push({
                fund_short_name: fund.fund_short_name,
                amc_name: fund.amc_name,
                isin: fund.isin,
                fund_full_name: fund.fund_full_name,
                category: fund.category,
                scheme_code: fund.scheme_code,
                nav: newNav,
                last_sync_at: amfiIsoDate,
                updated_at: now
            });
            stats.updated++;
          } else {
            stats.skipped++;
          }
        } else {
          if (!isValidNav) {
            console.warn(`[AMFI] Skipping invalid NAV for ${fund.fund_short_name} (${fund.isin}): "${rawNav}"`);
          }
          stats.errors++;
        }
      }
    }

    if (newEntries.length > 0) {
      // Insert new history records
      const { error: insertError } = await insertRows(supabase, 'fund_master_backend', newEntries);
        
      if (insertError) throw insertError;
      console.log(`Successfully inserted ${newEntries.length} new history entries into fund_master_backend.`);
    } else {
      console.log('No new NAV data found to insert.');
    }

    // 3. Cleanup: Keep only 7 days of data
    await cleanupOldHistory();

    return stats;
  } catch (error) {
    console.error('updateAllFundsNAV Error:', error.message);
    throw error;
  }
}

/**
 * Fetch NAV for a specific date from mfapi.in and update fund_master_backend.
 * Accepts date in YYYY-MM-DD format.
 */
export async function fetchNAVByDate(targetDate) {
  const summary = { total: 0, success: 0, failed: 0 };

  try {
    // Convert YYYY-MM-DD to DD-MM-YYYY for exact matching with mfapi.in format
    const [tY, tM, tD] = targetDate.split('-');
    const targetDateFormatted = `${tD}-${tM}-${tY}`;

    // 1. Fetch unique fund templates from database
    const { data: rawFunds, error: fetchError } = await fetchAllRows(supabase, 'fund_master_backend', {
      select: 'isin, scheme_code, fund_short_name, amc_name, fund_full_name, category',
      order: { column: 'last_sync_at', ascending: false }
    });

    if (fetchError) throw fetchError;
    if (!rawFunds || rawFunds.length === 0) {
      return { status: 'error', message: 'No funds found in database' };
    }

    const templates = new Map();
    for (const f of rawFunds) {
      if (!templates.has(f.isin) && f.scheme_code) {
        templates.set(f.isin, f);
      }
    }

    const fundList = Array.from(templates.values());
    summary.total = fundList.length;
    
    console.log(`Fetching exact NAV for ${fundList.length} funds for date ${targetDateFormatted}...`);

    const newEntries = [];
    const now = new Date().toISOString();
    const targetIsoDate = new Date(targetDate).toISOString();

    // Concurrency control: process in batches of 5
    const batchSize = 5;
    for (let i = 0; i < fundList.length; i += batchSize) {
      const batch = fundList.slice(i, i + batchSize);
      await Promise.all(batch.map(async (fund) => {
        try {
          let res;
          try {
            res = await axios.get(`https://api.mfapi.in/mf/${fund.scheme_code}`, { timeout: 15000 });
          } catch (err) {
            if (err.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || err.message?.includes('certificate')) {
              const agent = new https.Agent({ rejectUnauthorized: false });
              res = await axios.get(`https://api.mfapi.in/mf/${fund.scheme_code}`, { timeout: 15000, httpsAgent: agent });
            } else {
              throw err;
            }
          }
          const navHistory = res.data.data;

          if (navHistory && Array.isArray(navHistory)) {
            // Find EXACT match for targetDateFormatted
            const exactMatch = navHistory.find(entry => entry.date === targetDateFormatted);

            if (exactMatch) {
              const rawNav = exactMatch.nav;
              const selectedNav = parseFloat(rawNav);
              // ENSURE: Only insert if NAV is a valid positive number (not NaN, not null, not undefined, and > 0)
              const isValidNav = !isNaN(selectedNav) && selectedNav > 0 && String(rawNav).toLowerCase() !== 'n.a.';

              if (isValidNav) {
                newEntries.push({
                  fund_short_name: fund.fund_short_name,
                  amc_name: fund.amc_name,
                  isin: fund.isin,
                  fund_full_name: fund.fund_full_name,
                  category: fund.category,
                  scheme_code: fund.scheme_code,
                  nav: selectedNav,
                  last_sync_at: targetIsoDate,
                  updated_at: now
                });
                summary.success++;
              } else {
                console.warn(`[MFAPI] Skipping invalid NAV for ${fund.fund_short_name} on ${targetDateFormatted}: "${rawNav}"`);
                summary.failed++;
              }
            } else {
              // No exact match for this date (e.g., weekend or holiday)
              summary.failed++;
            }
          } else {
            summary.failed++;
          }
        } catch (err) {
          console.error(`Error fetching NAV for scheme ${fund.scheme_code}:`, err.message);
          summary.failed++;
        }
      }));
    }

    if (newEntries.length > 0) {
      // Upsert into fund_master_backend
      const { error: upsertError } = await upsertRows(supabase, 'fund_master_backend', newEntries, { onConflict: 'isin,last_sync_at' });

      if (upsertError) throw upsertError;
    }

    return { status: 'success', summary };

  } catch (error) {
    console.error('fetchNAVByDate Error:', error.message);
    return { status: 'error', message: error.message, summary };
  }
}

async function cleanupOldHistory() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const dateStr = sevenDaysAgo.toISOString();

  console.log(`Cleaning up records older than ${dateStr}...`);
  
  const { error } = await deleteRows(supabase, 'fund_master_backend', (q) => q.lt('last_sync_at', dateStr));

  if (error) {
    console.error('Cleanup old history failed:', error.message);
  } else {
    console.log('Cleanup completed.');
  }
}

function parseAmfiText(text) {
  const navMap = new Map();
  const lines = text.split(/\r?\n/);
  
  for (const line of lines) {
    const parts = line.split(';');
    if (parts.length >= 6) {
      const schemeCode = parts[0].trim();
      const nav = parts[4].trim(); 
      const date = parts[5].trim();
      
      if (schemeCode && nav && date) {
        navMap.set(schemeCode, { nav, date });
      }
    }
  }
  return navMap;
}

function parseAmfiDate(dateStr) {
  if (!dateStr) return null;
  
  // AMFI uses DD-MMM-YYYY (e.g., 07-May-2024)
  const parts = dateStr.trim().split('-');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const monthStr = parts[1].toLowerCase();
    const year = parts[2];
    
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    
    const month = months[monthStr];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // Fallback for YYYY-MM-DD or other formats
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  
  // Use local date parts to avoid UTC shift
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
