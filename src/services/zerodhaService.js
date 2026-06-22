import { KiteConnect } from 'kiteconnect';
import { supabase } from '../db/supabaseClient.js';
import ZerodhaLoginService from './zerodha/loginService.js';

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
      apiSecret: process.env.KITE_API_SECRET_Z1,
      userId: process.env.ZERODHA_USER_ID_Z1,
      password: process.env.ZERODHA_PASSWORD_Z1,
      totpSecret: process.env.ZERODHA_TOTP_SECRET_Z1
    },
    PDM: {
      apiKey: process.env.KITE_API_KEY_Z2,
      apiSecret: process.env.KITE_API_SECRET_Z2,
      userId: process.env.ZERODHA_USER_ID_Z2,
      password: process.env.ZERODHA_PASSWORD_Z2,
      totpSecret: process.env.ZERODHA_TOTP_SECRET_Z2
    },
    PSM: {
      apiKey: process.env.KITE_API_KEY_Z3,
      apiSecret: process.env.KITE_API_SECRET_Z3,
      userId: process.env.ZERODHA_USER_ID_Z3,
      password: process.env.ZERODHA_PASSWORD_Z3,
      totpSecret: process.env.ZERODHA_TOTP_SECRET_Z3
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
    console.error(`❌ No API Key found for account: ${accountId}`);
    return res.status(400).send(`Invalid account or missing API Key for ${accountId}`);
  }

  // Use ZERODHA_REDIRECT_URL from env if available
  const redirectUri = process.env.ZERODHA_REDIRECT_URL;
  let loginUrl = `https://kite.trade/connect/login?api_key=${creds.apiKey}&state=${accountId}`;
  
  if (redirectUri) {
    loginUrl += `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  console.log(`🔐 Redirecting ${accountId} to Zerodha login...`);
  // console.log(`🔗 URL: ${loginUrl}`);

  // Store accountId as fallback for callback if state is lost
  lastLoginAccount = accountId;

  res.redirect(loginUrl);
}

// ===============================
// CALLBACK ROUTE HANDLER
// ===============================
async function zerodhaCallback(req, res) {
  try {
    const { request_token, state, status, error: queryError } = req.query;

    console.log("🔍 Zerodha Callback Full Query:", req.query);
    console.log("🔍 lastLoginAccount fallback:", lastLoginAccount);

    if (queryError) {
      console.error("❌ Zerodha returned error:", queryError);
      return res.status(400).send(`Zerodha Login Error: ${queryError}`);
    }

    // Use state or fallback to our global tracker if Zerodha doesn't return state
    const accountId = state || lastLoginAccount;

    if (!request_token || !accountId) {
      console.error("❌ Zerodha callback missing params:", { 
        request_token: !!request_token, 
        state, 
        lastLoginAccount,
        status 
      });
      return res.status(400).send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2 style="color: #dc3545;">❌ Login Identification Failed</h2>
          <p>Missing <b>${!request_token ? 'request_token' : 'account identification'}</b>.</p>
          <p>Account ID detected: ${accountId || 'None'}</p>
          <p>Please try logging in again. If the issue persists, check if the "Redirect URL" in Zerodha Dashboard matches your backend URL.</p>
          <button onclick="window.close()" style="padding: 10px 20px; cursor: pointer; background: #333; color: #fff; border: none; border-radius: 5px;">Close</button>
        </div>
      `);
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

    // console.log(`✅ Zerodha login success for ${accountId}`);

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
      // console.log(`💾 Token saved for ${accountId}`);
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
async function fetchAndAggregateTradesForAccount(accountId) {
  try {
    if (!accountId) {
      return { success: false, statusCode: 400, message: 'Account is required' };
    }

    const creds = getZerodhaCreds(accountId);
    if (!creds) {
      return { success: false, statusCode: 400, message: 'Invalid account' };
    }

    const { fetchAllRows } = await import('../db/queries.js');
    const { data: tokenDataArr, error: tokenError } = await fetchAllRows(supabase, 'zerodha_tokens', {
      select: 'access_token',
      filters: [(q) => q.eq('account_id', accountId)],
      limit: 1
    });

    const tokenData = tokenDataArr && tokenDataArr.length > 0 ? tokenDataArr[0] : null;

    if (tokenError || !tokenData) {
      return { success: false, statusCode: 400, message: 'No access token found. Please login first.' };
    }

    const kite = new KiteConnect({
      api_key: creds.apiKey,
      access_token: tokenData.access_token
    });

    const trades = await kite.getTrades();
    const today = new Date().toISOString().split('T')[0];

    const deliveryBuyToday = trades.filter((t) => {
      const isCNC = t.product?.toUpperCase() === 'CNC';
      const isBUY = t.transaction_type?.toUpperCase() === 'BUY';
      const ts = t.fill_timestamp || t.exchange_timestamp;
      if (!ts) return false;

      let tradeDateStr;
      try {
        tradeDateStr = new Date(ts).toISOString().split('T')[0];
      } catch (err) {
        console.error('Date parse error for trade:', ts);
        return false;
      }

      return isCNC && isBUY && tradeDateStr === today;
    });

    if (deliveryBuyToday.length === 0) {
      const firstTrade = trades.length > 0 ? trades[0] : null;
      const firstTradeStr = firstTrade
        ? `[Prod: ${firstTrade.product}, Type: ${firstTrade.transaction_type}, Fill: ${firstTrade.fill_timestamp}, Exch: ${firstTrade.exchange_timestamp}]`
        : 'None';

      return {
        success: true,
        message: `No CNC BUY trades found for today (${today}) in ${accountId}. Total trades found: ${trades.length}. First trade: ${firstTradeStr}`,
        data: [],
        trades,
        formatted: [],
        inserted: 0,
        updated: 0,
        today
      };
    }

    const aggregation = {};
    deliveryBuyToday.forEach((t) => {
      const symbol = t.tradingsymbol;
      if (!aggregation[symbol]) {
        aggregation[symbol] = {
          symbol,
          isin: t.isin || null,
          total_qty: 0,
          total_cost: 0,
          account_id: accountId,
          date: today,
          broker: 'Zerodha',
          product: t.product || 'CNC',
          exchange: t.exchange || 'NSE'
        };
      }
      aggregation[symbol].total_qty += Number(t.quantity);
      aggregation[symbol].total_cost += Number(t.quantity) * Number(t.average_price);
    });

    const finalData = Object.values(aggregation).map((item) => ({
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

    await supabase
      .from('equity_positions')
      .delete()
      .lt('position_date', today);

    const { data: existingToday } = await fetchAllRows(supabase, 'equity_positions', {
      select: 'symbol, quantity, average_price',
      filters: [
        (q) => q.eq('account_id', accountId),
        (q) => q.eq('position_date', today)
      ]
    });

    const existingMap = new Map((existingToday || []).map((r) => [r.symbol, r]));
    const dataToInsert = [];
    const dataToUpdate = [];

    finalData.forEach((item) => {
      const existing = existingMap.get(item.symbol);
      if (!existing) {
        dataToInsert.push(item);
      } else if (
        Number(existing.quantity) !== Number(item.quantity) ||
        Number(existing.average_price) !== Number(item.average_price)
      ) {
        dataToUpdate.push(item);
      }
    });

    if (dataToInsert.length > 0) {
      const { error: insertError } = await supabase.from('equity_positions').insert(dataToInsert);
      if (insertError) {
        console.error('❌ Insert Error:', insertError.message, 'Data:', dataToInsert);
        return { success: false, statusCode: 500, message: `Failed to save aggregated trades: ${insertError.message}` };
      }
    }

    if (dataToUpdate.length > 0) {
      for (const item of dataToUpdate) {
        const { error: updateError } = await supabase
          .from('equity_positions')
          .update({ quantity: item.quantity, average_price: item.average_price })
          .match({ account_id: accountId, position_date: today, symbol: item.symbol });

        if (updateError) {
          console.error('❌ Update Error:', updateError.message, 'Data:', item);
        }
      }
    }

    return {
      success: true,
      message:
        dataToInsert.length > 0 || dataToUpdate.length > 0
          ? `Successfully processed ${dataToInsert.length} new and ${dataToUpdate.length} updated stocks`
          : 'All stocks already exist for today',
      data: [...dataToInsert, ...dataToUpdate],
      trades,
      formatted: finalData,
      inserted: dataToInsert.length,
      updated: dataToUpdate.length,
      today
    };
  } catch (err) {
    console.error('❌ Fetch/Aggregate error:', err.message);
    return { success: false, statusCode: 500, message: `Aggregation failed: ${err.message}` };
  }
}

async function fetchAndAggregateTrades(req, res) {
  const { account: accountId } = req.query;
  const result = await fetchAndAggregateTradesForAccount(accountId);
  if (!result.success) {
    return res.status(result.statusCode || 500).json(result);
  }
  return res.json(result);
}

// ===============================
// PLACE BUY ORDER
// ===============================
async function placeBuyOrder(accountId, symbol, quantity, orderType, price) {
  try {
    const creds = getZerodhaCreds(accountId);
    if (!creds) throw new Error("Invalid Zerodha account");

    const { fetchAllRows } = await import('../db/queries.js');
    const { data: tokenDataArr } = await fetchAllRows(supabase, "zerodha_tokens", {
      select: "access_token",
      filters: [(q) => q.eq("account_id", accountId)],
      limit: 1
    });

    const tokenData = tokenDataArr && tokenDataArr.length > 0 ? tokenDataArr[0] : null;

    if (!tokenData) throw new Error("No access token found for Zerodha");

    const kite = new KiteConnect({
      api_key: creds.apiKey,
      access_token: tokenData.access_token
    });

    const orderPayload = {
      exchange: "NSE",
      tradingsymbol: symbol,
      transaction_type: "BUY",
      quantity: quantity,
      order_type: orderType,
      product: "CNC"
    };

    if (orderType === "LIMIT") {
      orderPayload.price = price;
    } else if (orderType === "MARKET") {
      // Market protection disabled for market orders (-1 = unrestricted)
      orderPayload.market_protection = -1;
    }

    const orderResponse = await kite.placeOrder("regular", orderPayload);

    return {
      success: true,
      order_id: orderResponse.order_id
    };
  } catch (err) {
    console.error(`❌ Zerodha placeBuyOrder error for ${symbol}:`, err.message);
    throw err;
  }
}

// ===============================
// PLACE SELL ORDER
// ===============================
async function placeSellOrder(accountId, symbol, quantity, orderType, price) {
  try {
    const creds = getZerodhaCreds(accountId);
    if (!creds) throw new Error("Invalid Zerodha account");

    const { fetchAllRows } = await import('../db/queries.js');
    const { data: tokenDataArr } = await fetchAllRows(supabase, "zerodha_tokens", {
      select: "access_token",
      filters: [(q) => q.eq("account_id", accountId)],
      limit: 1
    });

    const tokenData = tokenDataArr && tokenDataArr.length > 0 ? tokenDataArr[0] : null;

    if (!tokenData) throw new Error("No access token found for Zerodha");

    const kite = new KiteConnect({
      api_key: creds.apiKey,
      access_token: tokenData.access_token
    });

    const orderPayload = {
      exchange: "NSE",
      tradingsymbol: symbol,
      transaction_type: "SELL",
      quantity: quantity,
      order_type: orderType === "MARKET" ? "MARKET" : "LIMIT",
      product: "CNC"
    };

    if (orderType === "LIMIT") {
      orderPayload.price = price;
    } else if (orderType === "MARKET") {
      orderPayload.market_protection = -1;
    }

    const orderResponse = await kite.placeOrder("regular", orderPayload);

    return {
      success: true,
      order_id: orderResponse.order_id,
      status: orderResponse.status,
      executed_price: orderResponse.average_price || orderResponse.price || null
    };
  } catch (err) {
    console.error(`❌ Zerodha placeOrder error for ${symbol}:`, err.message);
    throw err;
  }
}

// ===============================
// GET ORDER STATUS
// ===============================
async function getOrderStatus(accountId, orderId) {
  try {
    const creds = getZerodhaCreds(accountId);
    const { fetchAllRows } = await import('../db/queries.js');
    const { data: tokenDataArr } = await fetchAllRows(supabase, "zerodha_tokens", {
      select: "access_token",
      filters: [(q) => q.eq("account_id", accountId)],
      limit: 1
    });

    const tokenData = tokenDataArr && tokenDataArr.length > 0 ? tokenDataArr[0] : null;

    if (!tokenData) throw new Error("No access token found");

    const kite = new KiteConnect({
      api_key: creds.apiKey,
      access_token: tokenData.access_token
    });

    const orders = await kite.getOrderHistory(orderId);
    // Get latest status
    const latestOrder = orders[orders.length - 1];

    return {
      status: latestOrder.status, // OPEN, COMPLETE, REJECTED, CANCELLED
      average_price: latestOrder.average_price,
      filled_quantity: latestOrder.filled_quantity,
      status_message: latestOrder.status_message
    };
  } catch (err) {
    console.error(`❌ Zerodha getOrderStatus error:`, err.message);
    throw err;
  }
}

// ===============================
// AUTOMATED LOGIN
// ===============================
async function automateZerodhaLogin(req, res) {
  try {
    const accountId = req.query.account;
    if (!accountId) {
      return res.status(400).json({ error: "Account is required" });
    }

    const creds = getZerodhaCreds(accountId);
    if (!creds || !creds.apiKey) {
      return res.status(400).json({ error: `Invalid account or missing API Key for ${accountId}` });
    }

    console.log(`🤖 Starting automated login for ${accountId}...`);
    
    // Call the automation service
    const session = await ZerodhaLoginService.loginAndGenerateToken(accountId, creds);
    
    const accessToken = session.access_token;
    const publicToken = session.public_token;

    // Save Token in Supabase (same logic as callback)
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
      console.error("❌ DB Insert Error during automation:", error.message);
      return res.status(500).json({ error: "Failed to save token to database" });
    }

    console.log(`✅ Automated login success for ${accountId}`);
    res.json({ 
      success: true, 
      message: `Automated login successful for ${accountId}` 
    });

  } catch (err) {
    console.error("❌ Zerodha automation error:", err.message);
    res.status(500).json({ error: err.message || "Automated login failed" });
  }
}

// ===============================
// EXPORT
// ===============================
export {
  zerodhaLogin,
  zerodhaCallback,
  fetchAndAggregateTrades,
  fetchAndAggregateTradesForAccount,
  automateZerodhaLogin,
  placeBuyOrder,
  placeSellOrder,
  getOrderStatus
};
