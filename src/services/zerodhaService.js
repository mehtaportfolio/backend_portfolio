import { KiteConnect } from 'kiteconnect';
import { supabase } from '../db/supabaseClient.js';

// Global variable to track which account is currently logging in
// Since Zerodha sometimes doesn't return the 'state' parameter correctly
let lastLoginAccount = null;

// ===============================
// Get Credentials per Account
// ===============================
function getZerodhaCreds(accountId) {
  return {
    PM: {
      apiKey: process.env.KITE_API_KEY_Z1,
      apiSecret: process.env.KITE_API_SECRET_Z1
    },
    PDM: {
      apiKey: process.env.KITE_API_KEY_Z2,
      apiSecret: process.env.KITE_API_SECRET_Z2
    },
    PSM: {
      apiKey: process.env.KITE_API_KEY_Z3,
      apiSecret: process.env.KITE_API_SECRET_Z3
    }
  }[accountId];
}

// ===============================
// LOGIN ROUTE HANDLER
// ===============================
function zerodhaLogin(req, res) {
  const accountId = req.query.account;

  if (!accountId) {
    return res.status(400).send("Account is required");
  }

  const creds = getZerodhaCreds(accountId);

  if (!creds || !creds.apiKey) {
    return res.status(400).send("Invalid account");
  }

  const loginUrl = `https://kite.trade/connect/login?api_key=${creds.apiKey}&state=${accountId}`;

  console.log(`🔐 Redirecting ${accountId} to Zerodha login...`);

  // Store accountId as fallback for callback if state is lost
  lastLoginAccount = accountId;

  res.redirect(loginUrl);
}

// ===============================
// CALLBACK ROUTE HANDLER
// ===============================
async function zerodhaCallback(req, res) {
  try {
    const { request_token, state } = req.query;

    // Use state or fallback to our global tracker if Zerodha doesn't return state
    const accountId = state || lastLoginAccount;

    if (!request_token || !accountId) {
      console.error("❌ Zerodha callback missing params:", { request_token, state, lastLoginAccount });
      return res.status(400).send("Missing request_token or account identification. Please try logging in again.");
    }

    const creds = getZerodhaCreds(accountId);

    if (!creds) {
      return res.status(400).send("Invalid account");
    }

    const kite = new KiteConnect({
      api_key: creds.apiKey
    });

    // 🔥 Generate session
    const session = await kite.generateSession(
      request_token,
      creds.apiSecret
    );

    const accessToken = session.access_token;
    const publicToken = session.public_token;

    console.log(`✅ Zerodha login success for ${accountId}`);

    // ===============================
    // Save Token in Supabase
    // ===============================
    await supabase
      .from("zerodha_tokens")
      .delete()
      .eq("account_id", accountId);

    const { error } = await supabase
      .from("zerodha_tokens")
      .insert([
        {
          account_id: accountId,
          access_token: accessToken,
          public_token: publicToken,
          updated_at: new Date().toISOString()
        }
      ]);

    if (error) {
      console.error("❌ DB Insert Error:", error.message);
    } else {
      console.log(`💾 Token saved for ${accountId}`);
    }

    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h2 style="color: #28a745;">✅ Login Successful</h2>
        <p>Zerodha login successful for <b>${accountId}</b>.</p>
        <p>This window will close automatically in 3 seconds...</p>
        <button onclick="window.close()" style="padding: 10px 20px; cursor: pointer; background: #333; color: #fff; border: none; border-radius: 5px;">Close Now</button>
        <script>
          setTimeout(() => { window.close(); }, 3000);
        </script>
      </div>
    `);

  } catch (err) {
    console.error("❌ Zerodha callback error:", err.message);
    res.status(500).send("Login failed");
  }
}

// ===============================
// FETCH AND AGGREGATE TRADES
// ===============================
async function fetchAndAggregateTrades(req, res) {
  try {
    const { account: accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: "Account is required" });

    const creds = getZerodhaCreds(accountId);
    if (!creds) return res.status(400).json({ error: "Invalid account" });

    // Get token from Supabase
    const { data: tokenData, error: tokenError } = await supabase
      .from("zerodha_tokens")
      .select("access_token")
      .eq("account_id", accountId)
      .single();

    if (tokenError || !tokenData) {
      return res.status(400).json({ error: "No access token found. Please login first." });
    }

    const kite = new KiteConnect({
      api_key: creds.apiKey,
      access_token: tokenData.access_token
    });

    // Fetch trades
    console.log(`🔍 Fetching trades for ${accountId}...`);
    const trades = await kite.getTrades();
    console.log(`✅ Fetched ${trades.length} trades for ${accountId}`);

    // Get today's date in YYYY-MM-DD
    const today = new Date().toISOString().split("T")[0];
    console.log(`📅 Syncing for today: ${today}`);

    // Filter: DELIVERY BUY trades for today
    const deliveryBuyToday = trades.filter(t => {
      const isCNC = t.product?.toUpperCase() === "CNC";
      const isBUY = t.transaction_type?.toUpperCase() === "BUY";
      
      const ts = t.fill_timestamp || t.exchange_timestamp;
      if (!ts) return false;
      
      // Parse the trade date into YYYY-MM-DD format
      let tradeDateStr;
      try {
        tradeDateStr = new Date(ts).toISOString().split("T")[0];
      } catch (err) {
        console.error("Date parse error for trade:", ts);
        return false;
      }
      
      return isCNC && isBUY && tradeDateStr === today;
    });

    if (deliveryBuyToday.length === 0) {
      console.log(`ℹ️ No delivery buy trades found today for ${accountId} out of ${trades.length} total trades`);
      const firstTradeStr = trades.length > 0 ? 
        `[Prod: ${trades[0].product}, Type: ${trades[0].transaction_type}, Fill: ${trades[0].fill_timestamp}, Exch: ${trades[0].exchange_timestamp}]` : 
        "None";

      return res.json({ 
        message: `No CNC BUY trades found for today (${today}) in ${accountId}. Total trades found: ${trades.length}. First trade: ${firstTradeStr}`,
        data: [],
        debug: trades.length > 0 ? {
          firstTrade: {
            product: trades[0].product,
            type: trades[0].transaction_type,
            fill: trades[0].fill_timestamp,
            exchange: trades[0].exchange_timestamp
          }
        } : null
      });
    }

    // Aggregate by stock
    const aggregation = {};
    deliveryBuyToday.forEach(t => {
      const symbol = t.tradingsymbol;
      if (!aggregation[symbol]) {
        aggregation[symbol] = {
          symbol: symbol,
          isin: t.isin || null,
          total_qty: 0,
          total_cost: 0,
          account_id: accountId,
          date: today,
          broker: "Zerodha",
          product: t.product || "CNC",
          exchange: t.exchange || "NSE"
        };
      }
      aggregation[symbol].total_qty += Number(t.quantity);
      aggregation[symbol].total_cost += (Number(t.quantity) * Number(t.average_price));
    });

    // Calculate final weighted average and prepare for insert
    const finalData = Object.values(aggregation).map(item => ({
      broker: item.broker,
      account_id: item.account_id,
      symbol: item.symbol,
      isin: item.isin,
      quantity: item.total_qty,
      average_price: parseFloat((item.total_cost / item.total_qty).toFixed(2)),
      product: item.product,
      exchange: item.exchange,
      position_date: item.date
    }));

    // Insert into equity_positions
    const { error: insertError } = await supabase
      .from("equity_positions")
      .insert(finalData);

    if (insertError) {
      console.error("❌ Insert Error:", insertError.message, "Data:", finalData);
      return res.status(500).json({ error: "Failed to save aggregated trades: " + insertError.message });
    }

    console.log(`✅ Aggregated ${finalData.length} stocks for ${accountId}`);
    res.json({
      message: `Successfully aggregated ${finalData.length} stocks`,
      data: finalData
    });

  } catch (err) {
    console.error("❌ Fetch/Aggregate error:", err.message);
    res.status(500).json({ error: "Aggregation failed: " + err.message });
  }
}

// ===============================
// EXPORT
// ===============================
export {
  zerodhaLogin,
  zerodhaCallback,
  fetchAndAggregateTrades
};
