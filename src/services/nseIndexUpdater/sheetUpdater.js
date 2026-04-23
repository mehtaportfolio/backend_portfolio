import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

export async function updateGoogleSheet(indexData) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const CLIENT_EMAIL = process.env.GS_CLIENT_EMAIL;
  const PRIVATE_KEY = process.env.GS_PRIVATE_KEY ? process.env.GS_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
  const SHEET_NAME = "Stocks";

  if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    console.error("❌ [Sheet Updater] Missing Google Sheets credentials in environment variables.");
    return;
  }

 const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

  const sheets = google.sheets({ version: "v4", auth });

  try {
    console.log("📄 [Sheet Updater] Reading Sheet...");
    
    // Get sheet meta to find sheetId
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
    });

    const sheetInfo = meta.data.sheets.find(
      (s) => s.properties.title === SHEET_NAME
    );

    if (!sheetInfo) {
      console.log(`❌ [Sheet Updater] Sheet with name "${SHEET_NAME}" not found.`);
      return;
    }

    const sheetId = sheetInfo.properties.sheetId;

    // Get existing rows
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:Z200`,
    });

    const rows = getRes.data.values || [];
    const headers = rows[0]?.map(h => h.toLowerCase().trim()) || [];

    const symbolCol = headers.indexOf("symbol");
    const cmpCol = headers.indexOf("cmp");
    const lcpCol = headers.indexOf("lcp");

    if (symbolCol === -1 || cmpCol === -1 || lcpCol === -1) {
      console.log("❌ [Sheet Updater] Missing required headers (symbol, cmp, or lcp) in row 1.");
      return;
    }

    const requests = [];

    rows.forEach((row, rowIndex) => {
      if (rowIndex === 0) return;

      const symbol = row[symbolCol]?.trim().toUpperCase();

      if (indexData[symbol]) {
        console.log(`🔧 [Sheet Updater] Match found! Preparing update for ${symbol} at row ${rowIndex + 1}`);

        requests.push({
          updateCells: {
            range: {
              sheetId,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: cmpCol,
              endColumnIndex: cmpCol + 1,
            },
            rows: [
              {
                values: [{ userEnteredValue: { numberValue: indexData[symbol].cmp } }],
              },
            ],
            fields: "userEnteredValue",
          },
        });

        requests.push({
          updateCells: {
            range: {
              sheetId,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: lcpCol,
              endColumnIndex: lcpCol + 1,
            },
            rows: [
              {
                values: [{ userEnteredValue: { numberValue: indexData[symbol].lcp } }],
              },
            ],
            fields: "userEnteredValue",
          },
        });
      }
    });

    if (requests.length === 0) {
      console.log("⚠ [Sheet Updater] No matching rows found to update.");
      return;
    }

    console.log("✍ [Sheet Updater] Updating Google Sheet via batchUpdate...");
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });

    console.log("✅ [Sheet Updater] Sheet Update Complete.");
  } catch (err) {
    console.error("❌ [Sheet Updater] Error updating Google Sheet:", err.message);
    throw err;
  }
}
