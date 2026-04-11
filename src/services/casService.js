import { supabase } from '../db/supabaseClient.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';


function getPAN(accountName) {
  const key = `${accountName}_PAN`;
  return process.env[key];
}

// ================= PDF TEXT EXTRACTION =================
export async function extractTextFromPDF(buffer, accountName) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    password: getPAN(accountName),
  });

  const pdf = await loadingTask.promise;
  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const linesMap = {};
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (!linesMap[y]) linesMap[y] = [];
      linesMap[y].push(item);
    }

    const sortedY = Object.keys(linesMap).sort((a, b) => b - a);

    for (const y of sortedY) {
      const lineItems = linesMap[y].sort(
        (a, b) => a.transform[4] - b.transform[4]
      );
      const lineText = lineItems.map((item) => item.str).join("  ");
      fullText += lineText + "\n";
    }
  }

  return fullText;
}

// ================= CAS PARSER =================
export function parseCAS(text, accountName) {
  const results = [];
  const lines = text.split("\n");
  let currentISIN = "";
  let withinTargetSection = false;

  let currentOpeningBalance = 0;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Skip headers / garbage
    if (
      line.includes("Transaction Description") ||
      line.includes("लेनदेन") ||
      line.includes("Amount") ||
      line.includes("NAV")
    ) continue;

    // Section Start
    if (line.toUpperCase().includes("MUTUAL FUND UNITS HELD WITH MF/RTA")) {
      withinTargetSection = true;
      continue;
    }

    // Section End
    if (line.toUpperCase().includes("MUTUAL FUND UNITS HELD AS ON")) {
      withinTargetSection = false;
      continue;
    }

    if (!withinTargetSection) continue;

const openingMatch = line.match(/Opening Balance\s+([\d,.]+)/i);

if (openingMatch) {
  currentOpeningBalance = parseFloat(openingMatch[1].replace(/,/g, ""));
  continue;
}



    // ISIN logic
// ONLY capture ISIN from proper header lines (not transaction rows)
if (line.includes("ISIN")) {
  const isinMatch = line.match(/ISIN\s*:\s*([A-Z]{2}[A-Z0-9]{10})/i);

  if (isinMatch) {
    currentISIN = isinMatch[1];
    currentOpeningBalance = 0; // RESET FOR NEW ISIN
    continue;
  }
}

    // Split logic (robust)
    let parts = line.split(/\s{2,}/);
    if (parts.length < 4) {
      parts = line.split(/\s+/);
    }

    // Detect date anywhere in line
    const dateMatch = line.match(/\b\d{2}-\d{2}-\d{4}\b/);
    let dateIndex = -1;

    if (dateMatch) {
      parts.unshift(dateMatch[0]); // force date at index 0
      dateIndex = 0;
    }

    if (dateIndex === -1) {
      continue;
    }

    // Extract numeric columns
    const remainingParts = parts.slice(dateIndex + 1);
    const numSequence = [];
    const nonNumericPrefix = [];
    let inSequence = false;

    for (let i = remainingParts.length - 1; i >= 0; i--) {
      const p = remainingParts[i].trim();
      const cleaned = p.replace(/,/g, "");
      const isNum = p === "--" || /^-?\d*\.?\d+$/.test(cleaned);

      if (isNum && !inSequence) {
        numSequence.unshift(p);
      } else if (!isNum && numSequence.length > 0) {
        inSequence = true;
        nonNumericPrefix.unshift(p);
      } else if (!isNum) {
        nonNumericPrefix.unshift(p);
      } else {
        numSequence.unshift(p);
      }
    }

    const description = nonNumericPrefix.join(" ");

    if (numSequence.length >= 4) {
      const amount = parseFloat(numSequence[0].replace(/,/g, ""));
      const nav = parseFloat(numSequence[1].replace(/,/g, ""));
      const units = parseFloat(numSequence[3].replace(/,/g, ""));

      if (!isNaN(amount) && !isNaN(nav) && !isNaN(units)) {
        results.push({
          isin: currentISIN,
          date: parts[0],
          amount,
          nav,
          units,
          opening_balance: currentOpeningBalance,
          account_name: accountName,
          transaction_type: units >= 0 ? "buy" : "sell",
        });
      }
    }
  }

  return results;
}

// ================= PROCESS FUNCTION =================
export async function processCAS(buffer, accountName) {
  const text = await extractTextFromPDF(buffer, accountName);

  let transactions = parseCAS(text, accountName);

  console.log("Transactions found:", transactions.length);

  if (transactions.length === 0) {
    throw new Error("No transactions found in CAS.");
  }

  // Convert date format to YYYY-MM-DD
  transactions = transactions.map(tx => {
    const [day, month, year] = tx.date.split("-");
    return {
      ...tx,
      date: `${year}-${month}-${day}`
    };
  });


  // Clear existing data (optional)
  const { error: deleteError } = await supabase
    .from("mf_cas")
    .delete()
     .neq("id", 0);

  if (deleteError) {
    console.error("DELETE ERROR:", deleteError);
    throw new Error(deleteError.message);
  }

const {data, error: insertError } = await supabase
  .from("mf_cas")
  .insert(transactions)
   .select(); // 👈 important

  if (insertError) {
    console.error("SUPABASE ERROR:", insertError);
    throw new Error(insertError.message);
  }

return {
  parsed: transactions.length,
  inserted: data.length,
  message: `${data.length} rows inserted out of ${transactions.length}`,
};
}