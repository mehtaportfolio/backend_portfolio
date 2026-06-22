import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows, insertRows } from '../db/queries.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================
// SESSION MANAGEMENT (Manual Captcha)
// =============================
const sessions = new Map();

// Cleanup stale sessions every 10 mins
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (now - session.timestamp > 600000) { // 10 mins
            console.log(`🧹 Cleaning up stale session: ${id}`);
            session.browser.close().catch(() => {});
            sessions.delete(id);
        }
    }
}, 600000);

export async function initNpsSession(credentials) {
  const isProduction = (process.env.NODE_ENV === 'production' || process.env.RENDER) && process.platform !== 'win32';
  
  const browser = await puppeteer.launch({
    executablePath: isProduction 
        ? await chromium.executablePath() 
        : (process.platform === 'win32' 
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' 
            : '/usr/bin/google-chrome'),
    headless: isProduction ? chromium.headless : true,
    defaultViewport: isProduction ? chromium.defaultViewport : { width: 1366, height: 768 },
    args: isProduction ? [
        ...chromium.args,
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled"
    ] : [
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled"
    ],
    slowMo: 20,
    protocolTimeout: 180000,
  });

  const { pran, password } = credentials;
  const page = await browser.newPage();
  
  // Set a common User-Agent to appear more human
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
  
  const sessionId = Math.random().toString(36).substring(2, 15);

  try {
    console.log("🚀 Initializing NPS session (Manual Captcha)...");
    
    // More resilient navigation: use "load" instead of "networkidle2" and increase timeout
    await page.goto("https://cra.nps-proteantech.in/CRA/", { 
        waitUntil: "load", 
        timeout: 45000 
    });

    // Increased timeout for slow portal response
    await page.waitForSelector("#npsradio", { visible: true, timeout: 30000 });
    await page.click("#npsradio");
    
    await page.waitForSelector("input[name='userID']", { visible: true, timeout: 5000 });
    await page.type("input[name='userID']", pran, { delay: 30 });
    await page.type("#passwordId1", password, { delay: 30 });

    const captchaSelector = "#captcha img";
    await page.waitForSelector(captchaSelector, { visible: true, timeout: 10000 });
    
    // Wait for captcha to be fully loaded
    await new Promise(r => setTimeout(r, 2500));

    const captchaElement = await page.$(captchaSelector);
    const captchaBase64 = await captchaElement.screenshot({ encoding: "base64" });

    sessions.set(sessionId, {
        browser,
        page,
        pran,
        password,
        timestamp: Date.now()
    });

    console.log(`✅ Session ${sessionId} initialized. Captcha ready.`);
    return { sessionId, captchaBase64 };
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

export async function completeNpsLogin(sessionId, captchaValue, fy) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Session expired or invalid. Please try again.");

    const { page, browser, pran } = session;

    try {
        console.log(`🔑 Completing login for session ${sessionId}...`);
        
        // Clear and type captcha
        await page.click("#captchaVal", { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type("#captchaVal", captchaValue, { delay: 50 });
        
        await page.click("input[name='terms']");
        
        await Promise.all([
            page.click("input[type='submit']"),
            Promise.race([
                page.waitForSelector("a[href*='logout']", { timeout: 35000 }).then(() => 'success'),
                page.waitForFunction(() => 
                    document.body.innerText.includes("Invalid Captcha") || 
                    document.body.innerText.includes("Invalid User ID or Password") ||
                    document.body.innerText.includes("Already Logged In") ||
                    document.body.innerText.includes("expired"),
                    { timeout: 35000 }
                ).then(() => 'failed_or_warning')
            ]).catch(() => 'timeout')
        ]);

        await new Promise(r => setTimeout(r, 2000));
        const content = await page.evaluate(() => document.body.innerText);

        if (content.includes("Invalid Captcha")) {
            // Take new screenshot and throw error to retry
            const captchaElement = await page.$("#captcha img");
            const newCaptcha = await captchaElement.screenshot({ encoding: "base64" });
            session.timestamp = Date.now();
            throw { message: "Invalid Captcha", newCaptcha };
        }

        if (content.includes("Already Logged In")) {
            console.log("⚠️ Already logged in detected. Resolving...");
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"));
                const okBtn = buttons.find(b => {
                    const t = (b.innerText || b.value || "").toUpperCase();
                    return t.includes("OK") || t.includes("YES") || t.includes("CONTINUE");
                });
                if (okBtn) okBtn.click();
            });
            await new Promise(r => setTimeout(r, 5000));
            // Recapture captcha if it appeared again or just retry login? 
            // Usually after "Already Logged In" it redirects back or stays on page.
            // For simplicity, let's ask for captcha again if needed.
            const captchaElement = await page.$("#captcha img");
            const newCaptcha = await captchaElement.screenshot({ encoding: "base64" });
            throw { message: "Already Logged In - Handled. Please enter the NEW captcha.", newCaptcha };
        }

        if (!content.includes("Logout") && !(await page.$("a[href*='logout']"))) {
            throw new Error("Login failed. Please check credentials or captcha.");
        }

        console.log("✅ Login successful. Fetching data...");
        await clearPopups(page);

        // Navigation logic
        console.log("🖱️ Navigating to Transaction Statement...");
        await page.evaluate(() => {
            const menus = Array.from(document.querySelectorAll("a, li, span"));
            const accountStatementMenu = menus.find(el => el.innerText.includes("Account Statement"));
            if (accountStatementMenu) {
                accountStatementMenu.click();
                // Minimal wait for menu to expand
            }
        });
        await new Promise(r => setTimeout(r, 500));
        await page.evaluate(() => {
            const transactionMenu = Array.from(document.querySelectorAll("a, li, span"))
                .find(el => el.innerText.includes("Transaction Statement"));
            if (transactionMenu) transactionMenu.click();
        });

        try {
            await page.waitForFunction(() => document.body.innerText.includes("Statement of Transaction"), { timeout: 15000 });
        } catch (e) {
            await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll("a"));
                const target = links.find(l => l.innerText.includes("Transaction") && l.innerText.includes("Statement"));
                if (target) target.click();
            });
            await page.waitForFunction(() => document.body.innerText.includes("Statement of Transaction"), { timeout: 15000 });
        }

        await clearPopups(page);

        // FY Selection
        console.log(`⚙️ Selecting FY: ${fy}...`);
        const targetFyClean = fy.replace(/[^0-9]/g, ''); 
        await page.evaluate((target) => {
            const selects = Array.from(document.querySelectorAll("select"));
            const fySelect = selects.find(s => {
                const name = (s.name || "").toLowerCase();
                const id = (s.id || "").toLowerCase();
                return (name.includes("fy") || name.includes("year") || id.includes("fy") || id.includes("year")) && s.innerText.includes("202");
            });
            if (fySelect) {
                const options = Array.from(fySelect.options);
                const option = options.find(opt => {
                    const optText = opt.text.replace(/[^0-9]/g, '');
                    return optText.includes(target) || target.includes(optText) || opt.text.includes(target.substring(0, 4));
                });
                if (option) {
                    fySelect.value = option.value;
                    fySelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }, targetFyClean);

        await new Promise(r => setTimeout(r, 2000)); // Reduced wait

        console.log("🔘 Clicking Generate Statement...");
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"));
            const btn = buttons.find(b => {
                const t = (b.innerText || b.value || "").toLowerCase();
                return t.includes("generate") || t.includes("statement");
            });
            if (btn) btn.click();
        });

        console.log("⏳ Waiting for report to load...");
        await Promise.race([
            page.waitForFunction(() => document.body.innerText.includes("Transaction Details"), { timeout: 20000 }),
            new Promise(r => setTimeout(r, 15000))
        ]);

        const pageContent = await page.evaluate(() => document.body.innerText);
        const pranMatch = pageContent.match(/PRAN\s+(\d{12})/);
        const extractedPran = pranMatch ? pranMatch[1] : pran;

        const extractedData = await page.evaluate(() => {
            const rawResults = [];
            const allTables = Array.from(document.querySelectorAll("table"));
            
            // Filter for tables that actually contain transactions and are NOT nested inside another transaction table
            const tables = allTables.filter(t => {
                const text = t.innerText.toLowerCase();
                const hasHeaders = text.includes("date") && text.includes("description") && (text.includes("amount") || text.includes("units"));
                if (!hasHeaders) return false;
                
                // Avoid nested tables: check if any parent is ALSO a table that would match
                let parent = t.parentElement;
                while (parent && parent.tagName !== 'BODY') {
                    if (parent.tagName === 'TABLE') {
                        const pText = parent.innerText.toLowerCase();
                        if (pText.includes("date") && pText.includes("description")) return false;
                    }
                    parent = parent.parentElement;
                }
                return true;
            });

            tables.forEach((table) => {
                const rows = Array.from(table.querySelectorAll("tr"));
                if (rows.length < 2) return;
                
                let tableHeaderScheme = "";
                // 1. Search siblings ABOVE the table for a scheme name
                let prev = table.previousElementSibling;
                while (prev && !tableHeaderScheme) {
                    const text = (prev.innerText || "").toUpperCase();
                    if (text.includes("SCHEME") && (text.includes("PENSION") || text.includes("TIER"))) {
                        tableHeaderScheme = text.trim();
                        break;
                    }
                    prev = prev.previousElementSibling;
                }

                let currentSchemeName = tableHeaderScheme;
                const dateRegex = /^\d{2}-[A-Za-z]{3}-\d{4}$/;

                rows.forEach((row) => {
                    const rowText = (row.innerText || "").toUpperCase();
                    
                    // 2. Check if this specific ROW acts as a scheme header
                    if (rowText.includes("SCHEME") && (rowText.includes("PENSION") || rowText.includes("TIER"))) {
                        if (!rowText.includes("DATE") && !rowText.includes("DESCRIPTION")) {
                            currentSchemeName = row.innerText.trim();
                        }
                    }

                    const cols = Array.from(row.querySelectorAll("td, th")).map((c) => c.innerText.trim());
                    // 3. Data row check
                    if (cols.length >= 2 && dateRegex.test(cols[0])) {
                        if (!currentSchemeName) return; 

                        rawResults.push({
                            scheme: currentSchemeName,
                            date: cols[0],
                            description: cols[1],
                            amountRaw: cols[2] || "",
                            navRaw: cols[3] || "",
                            unitsRaw: cols[4] || ""
                        });
                    }
                });
            });

            // 4. Batch Deduplication (within the same fetch)
            const uniqueKeys = new Set();
            const uniqueResults = [];
            
            rawResults.forEach(res => {
                const key = `${res.scheme}|${res.date}|${res.description}|${res.amountRaw}|${res.unitsRaw}|${res.navRaw}`;
                if (!uniqueKeys.has(key)) {
                    uniqueKeys.add(key);
                    uniqueResults.push(res);
                }
            });

            // Group by scheme for parseNPS compatibility
            const grouped = {};
            uniqueResults.forEach(res => {
                if (!grouped[res.scheme]) grouped[res.scheme] = [];
                grouped[res.scheme].push({
                    date: res.date,
                    description: res.description,
                    amountRaw: res.amountRaw,
                    navRaw: res.navRaw,
                    unitsRaw: res.unitsRaw
                });
            });

            return Object.entries(grouped).map(([scheme, transactions]) => ({ scheme, transactions }));
        });

        await performLogout(page);
        sessions.delete(sessionId);
        await browser.close();

        return { pran: extractedPran, data: extractedData };
    } catch (err) {
        if (err.newCaptcha) throw err; // Special case for captcha retry
        if (browser) await browser.close();
        sessions.delete(sessionId);
        throw err;
    }
}

// =============================
// UTILS
// =============================
async function clearPopups(page) {
    try {
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a"));
            const closeBtn = buttons.find(b => {
                const text = (b.innerText || b.value || "").toLowerCase();
                return text === "cancel" || text === "close" || text === "x" || text.includes("skip") || text.includes("remind me later");
            });
            if (closeBtn) closeBtn.click();

            const selectors = ['.modal', '.overlay', '.popup', '#p-dialog', '[role="dialog"]', '.ui-dialog'];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    el.style.display = 'none';
                    el.style.visibility = 'hidden';
                });
            });

            document.querySelectorAll('.modal-backdrop, .ui-widget-overlay').forEach(el => el.remove());
        });
    } catch (e) {
        // Silent fail
    }
}

async function performLogout(page) {
    console.log("🚪 Attempting to logout...");
    try {
        await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll("a, span, button"));
            const logoutLink = links.find(l => (l.innerText || "").toLowerCase().includes("logout"));
            if (logoutLink) logoutLink.click();
        });
        await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
        console.log("✅ Logout requested");
    } catch (e) {
        console.log("⚠️ Logout failed:", e.message);
    }
}

// =============================
// PARSER
// =============================
// =============================
// PARSER UTILS
// =============================
const monthMap = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
    'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
};

function normalizeNpsDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const day = parts[0].padStart(2, '0');
    const month = monthMap[parts[1]] || '01';
    const year = parts[2];
    return `${year}-${month}-${day}`;
}

function cleanSchemeName(name) {
    if (!name) return "Unknown Scheme";
    // Remove tabs, newlines, percentages, and "Scheme X" patterns
    let clean = name.replace(/Scheme\s+\d+/gi, '')
                    .replace(/[\t\n\r]/g, ' ')
                    .replace(/\d+\.?\d*%/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
    // Remove leading/trailing non-alphanumeric (except parentheses)
    clean = clean.replace(/^[^a-zA-Z0-9(]+|[^a-zA-Z0-9)]+$/g, '').trim();
    return clean || "Unknown Scheme";
}

function parseAmount(val) {
  if (!val || val === "-" || val === "0.00" || val.trim() === "") return 0;
  let clean = val.replace(/,/g, "").trim();
  let isNegative = clean.includes("(") || clean.includes("-");
  let numericPart = clean.replace(/[()\-]/g, "").trim();
  let amount = parseFloat(numericPart);
  return isNegative ? -Math.abs(amount) : amount;
}

export function parseNPS(data) {
  const results = [];
  let schemes = [];

  if (typeof data === "string") {
    const txIndex = data.indexOf("Transaction Details");
    const relevantText = txIndex !== -1 ? data.substring(txIndex) : data;
    const lines = relevantText.split("\n").map(l => l.trim()).filter(Boolean);
    const dateRegex = /\d{2}-[A-Za-z]{3}-\d{4}/;
    const numRegex = /-?\(?[\d,]+(?:\.\d+)?\)?/g;
    
    let currentScheme = "Unknown Scheme";
    let transactions = [];

    for (let line of lines) {
      if (line.includes("SCHEME") && line.includes("PENSION")) {
        if (transactions.length > 0) {
          schemes.push({ scheme: currentScheme, transactions });
          transactions = [];
        }
        currentScheme = line;
      } else if (dateRegex.test(line)) {
        const dateMatch = line.match(dateRegex)[0];
        const nums = line.match(numRegex) || [];
        transactions.push({
          date: dateMatch,
          description: line,
          amountRaw: nums.length >= 3 ? nums[nums.length - 3] : (nums[0] || ""),
          navRaw: nums.length >= 3 ? nums[nums.length - 2] : "",
          unitsRaw: nums.length >= 3 ? nums[nums.length - 1] : ""
        });
      }
    }
    if (transactions.length > 0) schemes.push({ scheme: currentScheme, transactions });
  } else {
    schemes = data;
  }

  schemes.forEach((s) => {
    s.transactions.forEach((tx) => {
      const amount = parseAmount(tx.amountRaw);
      const units = parseAmount(tx.unitsRaw);
      
      // Skip if units or amount is zero
      if (!units || Math.abs(units) < 1e-8) return;
      if (!amount || Math.abs(amount) < 1e-8) return;

      let type = null;
      const desc = tx.description.toLowerCase();

      if (desc.includes("billing") || desc.includes("persistency") || desc.includes("charge")) {
        type = "charges";
      } else if (desc.includes("withdrawal") || desc.includes("redemption") || desc.includes("sell")) {
        type = "sell";
      } else if (desc.includes("contribution") || desc.includes("buy")) {
        type = "buy";
      }
      
      // Skip if type is not recognized (must be buy, sell, or charges)
      if (!type) return;
      
      results.push({
        scheme: cleanSchemeName(s.scheme),
        date: normalizeNpsDate(tx.date),
        description: tx.description,
        type,
        amount: Math.abs(amount || 0).toString(),
        units: Math.abs(units || 0).toString(),
        nav: Math.abs(parseAmount(tx.navRaw) || 0).toString(),
        status: "fetched"
      });
    });
  });

  return results;
}

export async function saveTransactions(pran, transactions) {
  if (transactions.length === 0) return 0;

  // Helper to create a consistent key for deduplication
  const getTxKey = (tx) => {
    const amt = parseFloat(tx.amount).toFixed(2);
    const unt = parseFloat(tx.units).toFixed(4);
    const nv = parseFloat(tx.nav).toFixed(4);
    // Use ISO date format for comparison if available
    const date = tx.date; 
    return `${tx.scheme}|${date}|${tx.description}|${amt}|${unt}|${nv}`;
  };

  // 1. Deduplicate within the incoming batch first
  const batchSeen = new Set();
  const uniqueBatch = transactions.filter(tx => {
    const key = getTxKey(tx);
    if (batchSeen.has(key)) return false;
    batchSeen.add(key);
    return true;
  });

  // 2. Check against existing database records
  const { data: existing } = await fetchAllRows(supabase, "nps_raw_temp", {
    select: "scheme, date, description, amount, units, nav",
    filters: [(q) => q.eq("pran", pran)]
  });

  const existingKeys = new Set(
    (existing || []).map(tx => getTxKey(tx))
  );

  const newRows = uniqueBatch
    .filter(tx => !existingKeys.has(getTxKey(tx)))
    .map(tx => ({ pran, ...tx }));

  if (newRows.length === 0) return 0;

  const { error } = await insertRows(supabase, "nps_raw_temp", newRows);
  if (error) throw error;
  return newRows.length;
}
