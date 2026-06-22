import { supabase } from '../db/supabaseClient.js';
import { deleteRows, insertRows } from '../db/queries.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Extract text from PDF buffer using pdfjs-dist
 */
export async function extractTextFromPDF(buffer) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
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
      const lineItems = linesMap[y].sort((a, b) => a.transform[4] - b.transform[4]);
      const lineText = lineItems.map((item) => item.str).join("  ");
      fullText += lineText + "\n";
    }
  }
  return fullText;
}

/**
 * Clean numeric string from PDF (handles commas and parentheses for negatives)
 */
function cleanNum(str) {
  if (!str) return 0;
  let s = str.trim().replace(/,/g, '');
  if (s.startsWith('(') && s.endsWith(')')) {
    s = '-' + s.substring(1, s.length - 1);
  }
  return parseFloat(s) || 0;
}

/**
 * Format DD-MMM-YYYY to YYYY-MM-DD
 */
function formatDate(dateStr) {
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [day, month, year] = parts;
  return `${year}-${months[month] || '01'}-${day.padStart(2, '0')}`;
}

/**
 * Map transaction description and units to type (buy, sell, charges)
 */
function getTransactionType(description, units) {
  const desc = (description || "").toLowerCase();
  if (desc.includes("billing") || desc.includes("charges") || desc.includes("persistency")) {
    return "charges";
  }
  if (desc.includes("withdrawal") || desc.includes("redemption") || units < 0) {
    return "sell";
  }
  return "buy";
}

/**
 * Parse NPS PDF text
 */
export function parseNpsPdf(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const transactions = [];
  let currentScheme = "";
  let inTransactionDetails = false;
  let pendingDescription = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("Transaction Details")) {
      inTransactionDetails = true;
      continue;
    }

    if (!inTransactionDetails) continue;

    if (line.includes("Notes") || line.includes("Retired life ka sahara")) {
      break;
    }

    // Scheme names usually end with TIER I POP or TIER II POP
    if (line.endsWith("TIER I POP") || line.endsWith("TIER II POP")) {
      currentScheme = line;
      pendingDescription = "";
      continue;
    }

    if (line.startsWith("Date") && line.includes("Description")) continue;

    const dateMatch = line.match(/^(\d{2}-[A-Za-z]{3}-\d{4})/);
    const numericParts = line.match(/(\(?[\d,.]+\)?)\s+([\d,.]+)\s+(\(?[\d,.]+\)?)$/);

    if (dateMatch && numericParts) {
      const date = dateMatch[1];
      const rest = line.substring(date.length, line.length - numericParts[0].length).trim();
      
      const amount = cleanNum(numericParts[1]);
      const nav = cleanNum(numericParts[2]);
      const units = cleanNum(numericParts[3]);
      const finalDesc = (pendingDescription + " " + rest).trim();

      const txn = {
        scheme: currentScheme,
        date: formatDate(date),
        description: finalDesc,
        amount: Math.abs(amount), // All positive values
        nav: Math.abs(nav),       // All positive values
        units: Math.abs(units),   // All positive values
        type: getTransactionType(finalDesc, units),
        status: "Processed"
      };
      
      // Look ahead for continuing description
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (nextLine.match(/^(\d{2}-[A-Za-z]{3}-\d{4})/) || nextLine.endsWith("TIER I POP") || nextLine.endsWith("TIER II POP") || nextLine.includes("Notes")) {
          break;
        }
        if (!nextLine.match(/(\(?[\d,.]+\)?)\s+([\d,.]+)\s+(\(?[\d,.]+\)?)$/)) {
            txn.description += " " + nextLine;
            // Re-evaluate type if description grows (units is already absolute, use original logic's units)
            txn.type = getTransactionType(txn.description, units);
        } else {
            break;
        }
        j++;
        i = j - 1; // Advance outer loop
      }

      transactions.push(txn);
      pendingDescription = "";
    } else if (dateMatch) {
       // Only date, maybe opening balance or just start of multi-line
       if (line.includes("Opening balance") || line.includes("Closing Balance")) {
           pendingDescription = "";
           continue;
       }
       pendingDescription += " " + line;
    } else {
      pendingDescription += " " + line;
    }
  }

  return transactions;
}

/**
 * Process NPS PDF buffer, parse and save to DB
 */
export async function processNpsPdf(buffer) {
  const text = await extractTextFromPDF(buffer);
  const transactions = parseNpsPdf(text);
  
  if (transactions.length === 0) {
    throw new Error("No transactions found in NPS PDF.");
  }

  // Clear existing table data first
  const { error: deleteError } = await deleteRows(supabase, 'nps_pdf', (q) => q.neq('id', '00000000-0000-0000-0000-000000000000'));
  
  if (deleteError) {
    console.error("Error clearing nps_pdf table:", deleteError);
    throw deleteError;
  }

  if (transactions.length > 0) {
    const { error: insertError } = await insertRows(supabase, 'nps_pdf', transactions);
    if (insertError) throw insertError;
  }

  return {
    total: transactions.length,
    added: transactions.length,
    message: "Table cleared and fresh data imported (positive values, types: buy/sell/charges)."
  };
}
