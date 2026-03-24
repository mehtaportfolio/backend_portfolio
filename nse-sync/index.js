const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();


// --- Supabase setup ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- NSE setup ---
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchIndex(symbol) {
  try {
    const homepage = "https://www.nseindia.com";
    const url = `${homepage}/api/equity-stockIndices?index=${encodeURIComponent(symbol)}`;

    // Step 1: Hit homepage to get cookies
    const homeRes = await client.get(homepage, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });


    // Step 2: Wait a bit
    await sleep(1500);

    // Step 3: Call API with cookies
    const res = await client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.nseindia.com/",
        "X-Requested-With": "XMLHttpRequest"
      }
    });

    return res.data;
  } catch (err) {
    if (err.response) {
      console.error(`❌ ${symbol} failed:`, err.response.status, err.response.statusText);
      console.error("Headers:", err.response.headers);
      console.error("Data:", err.response.data);
    } else {
      console.error(`❌ ${symbol} error:`, err.message);
    }
    return null;
  }
}




async function syncIndices() {
  const indices = ["NIFTY MIDCAP 100", "NIFTY SMALLCAP 250"];

  for (const index of indices) {
    const data = await fetchIndex(index);

    if (data && data.data && data.data.length > 0) {
      const cmp = data.data[0].lastPrice;
      const lcp = data.data[0].previousClose;


      // Save into Supabase
      const { error } = await supabase
        .from("stock_master")
        .update({ cmp, lcp })
        .eq("stock_name", index);

      if (error) console.error("Supabase error:", error.message);
    }
  }
}

syncIndices();
