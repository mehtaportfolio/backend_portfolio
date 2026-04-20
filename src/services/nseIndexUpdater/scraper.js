import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const INDEX_MAP = {
  "NIFTY MIDCAP 100": "NIFTY MIDCAP 100",
  "NIFTY SMALLCAP 250": "NIFTY SMLCAP 250",
};

const BASE_URL = "https://www.nseindia.com";
const MARKET_PAGE = "https://www.nseindia.com/market-data/live-market-indices";
const API_URL = "https://www.nseindia.com/api/allIndices";

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Host": "www.nseindia.com",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};

export async function fetchNSEIndices() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar }));

  try {
    console.log("📡 [NSE Scraper] Step 1: Visiting NSE Homepage...");
    const homeRes = await client.get(BASE_URL, { headers });
    console.log(`✅ [NSE Scraper] Homepage: ${homeRes.status}. Waiting 1s...`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log("📡 [NSE Scraper] Step 2: Visiting Market Page...");
    await client.get(MARKET_PAGE, {
      headers: {
        ...headers,
        Referer: BASE_URL,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document"
      },
    });
    console.log(`✅ [NSE Scraper] Market Page visited. Waiting 2s...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("📡 [NSE Scraper] Step 3: Fetching Indices API...");
    const res = await client.get(API_URL, {
      headers: {
        ...headers,
        Referer: MARKET_PAGE,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty"
      },
    });
    console.log(`✅ [NSE Scraper] API Status: ${res.status}`);

    const output = {};

    if (res.data && res.data.data) {
      for (const [display, api] of Object.entries(INDEX_MAP)) {
        const data = res.data.data.find((d) => d.indexSymbol === api);
        output[display] = data
          ? { cmp: data.last, lcp: data.previousClose }
          : { cmp: null, lcp: null };
      }
    }

    console.log("📦 [NSE Scraper] Data fetched successfully.");
    return output;
  } catch (err) {
    console.error("❌ [NSE Scraper] Error fetching NSE:", err.message);
    if (err.response) {
      console.error("[NSE Scraper] Status:", err.response.status);
    }
    throw err;
  }
}
