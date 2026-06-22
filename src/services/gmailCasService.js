import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '../db/supabaseClient.js';
import { extractTextFromPDF } from './casService.js';
import logEmitter from '../utils/logger.js';

export function parseRawCAS(text, accountName) {
    const results = [];
    const lines = text.split("\n");
    let currentISIN = "";
    let currentFundName = "";
    let withinTargetSection = true; // Relaxed for now to catch more data

    const monthsMap = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
    };

    const formatDate = (dateStr) => {
        const mmmMatch = dateStr.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
        if (mmmMatch) {
            const day = mmmMatch[1].padStart(2, '0');
            const month = monthsMap[mmmMatch[2]] || '01';
            const year = mmmMatch[3];
            return `${year}-${month}-${day}`;
        }
        const mmMatch = dateStr.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (mmMatch) {
            const day = mmMatch[1].padStart(2, '0');
            const month = mmMatch[2].padStart(2, '0');
            const year = mmMatch[3];
            return `${year}-${month}-${day}`;
        }
        return dateStr;
    };

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        // ISIN & Fund Name detection
        if (line.includes("ISIN")) {
            const isinMatch = line.match(/ISIN\s*[:\s]*([A-Z]{2}[A-Z0-9]{10})/i);
            if (isinMatch) {
                currentISIN = isinMatch[1];
                let fundPart = line.split(/ISIN/i)[0].trim();
                fundPart = fundPart.replace(/^[A-Z0-9]+-/, "");
                currentFundName = fundPart.replace(/[:\-]$/, "").trim();
                // logEmitter.log(`🔍 Found Fund: ${currentFundName} | ISIN: ${currentISIN}`);
                continue;
            }
        }

        // Transaction line detection
        const dateMatch = line.match(/\b\d{1,2}-([A-Za-z]{3}|\d{1,2})-\d{4}\b/);
        
        if (dateMatch) {
            const lowerLine = line.toLowerCase();
            // Skip summary/total rows
            if (lowerLine.includes("closing unit balance") || 
                lowerLine.includes("market value") || 
                lowerLine.includes("total cost value") ||
                lowerLine.includes("opening unit balance")) {
                continue;
            }

            // Find all numbers with decimals (e.g., 1,499.93 or 12.784)
            const numericParts = line.match(/-?[\d,]+\.\d{2,4}/g) || [];
            
            if (numericParts.length >= 1) {
                const amount = parseFloat(numericParts[0].replace(/,/g, ""));
                const units = numericParts.length > 1 ? parseFloat(numericParts[1].replace(/,/g, "")) : 0;
                const nav = numericParts.length > 2 ? parseFloat(numericParts[2].replace(/,/g, "")) : 0;

                // ONLY insert if units and nav are non-zero (to skip summary rows that have dates)
                if (!isNaN(amount) && !isNaN(units) && !isNaN(nav) && units !== 0 && nav !== 0) {
                    // Determine transaction type based on text
                    let type = "other";
                    if (lowerLine.includes("purchase") || lowerLine.includes("subscription")) type = "buy";
                    else if (lowerLine.includes("redemption") || lowerLine.includes("switch out")) type = "sell";
                    else if (lowerLine.includes("dividend")) type = "dividend";
                    else if (lowerLine.includes("stamp duty")) type = "stamp_duty";
                    else if (lowerLine.includes("systematic investment")) type = "buy"; // SIP

                    results.push({
                        account_name: accountName,
                        fund_full_name: currentFundName || "Unknown Fund",
                        isin: currentISIN || "Unknown ISIN",
                        date: formatDate(dateMatch[0]),
                        transaction_type: type,
                        units: Math.abs(units),
                        nav: nav,
                        amount: amount
                    });
                }
            }
        }
    }

    return results;
}

export async function fetchAndProcessGmailCAS(accountName) {
    const email = process.env[`EMAIL_${accountName}`];
    const password = process.env[`GMAIL_PASSWORD_${accountName}`] || process.env[`GMAIL_PASSWOROD_${accountName}`];
    const host = process.env.IMAP_HOST || 'imap.gmail.com';
    const port = parseInt(process.env.IMAP_PORT || '993');
    const pdfPassword = process.env.PDF_PASSWORD || process.env[`${accountName}_PAN`];

    if (!email || !password) {
        throw new Error(`Gmail credentials missing for ${accountName}`);
    }

    logEmitter.log(`📧 Connecting to Gmail for ${accountName} (${email})...`);

    const client = new ImapFlow({
        host,
        port,
        secure: true,
        auth: {
            user: email,
            pass: password
        },
        logger: false
    });

    try {
        await client.connect();
        logEmitter.log("✅ Connected to IMAP");

        let lock = await client.getMailboxLock('INBOX');
        try {
            const searchCriteria = {
                subject: 'Consolidated Account Statement - CAMS Mailback Request'
            };
            
            logEmitter.log(`🔍 Searching for emails with subject: "${searchCriteria.subject}"`);
            
            const messages = await client.search(searchCriteria);
            if (messages.length === 0) {
                logEmitter.log("❌ No matching emails found.");
                return { success: false, message: "No CAS emails found in inbox." };
            }

            const lastUid = messages[messages.length - 1];
            logEmitter.log(`📥 Fetching latest email (UID: ${lastUid})...`);

            const message = await client.fetchOne(lastUid, { source: true });
            const parsed = await simpleParser(message.source);

            const attachment = parsed.attachments.find(att => att.contentType === 'application/pdf' || att.filename?.toLowerCase().endsWith('.pdf'));
            if (!attachment) {
                logEmitter.log("❌ No PDF attachment found in the latest email.");
                return { success: false, message: "No PDF attachment found." };
            }

            logEmitter.log(`📄 Found PDF attachment: ${attachment.filename}. Parsing...`);

            const text = await extractTextFromPDF(attachment.content, accountName, pdfPassword);
            
            if (!text || text.trim().length === 0) {
                 logEmitter.log("❌ Text extraction failed (empty output).");
                 return { success: false, message: "Text extraction failed." };
            }

            let transactions = parseRawCAS(text, accountName);

            if (transactions.length === 0) {
                logEmitter.log("❌ No transactions parsed. Debugging first 500 chars of PDF text...");
                logEmitter.log(`TEXT PREVIEW: ${text.substring(0, 500).replace(/\n/g, ' ')}`);
                return { success: false, message: "No transactions found in PDF." };
            }

            logEmitter.log(`✅ Parsed ${transactions.length} transactions. Filtering duplicates...`);

            // 1. Fetch ALL existing records for this account from mf_raw_cas
            const { fetchAllRows } = await import('../db/queries.js');
            const { data: existingRecords, error: fetchError } = await fetchAllRows(supabase, 'mf_raw_cas', {
                filters: [(q) => q.eq('account_name', accountName)]
            });

            if (fetchError) {
                console.error("Error fetching existing records for duplicate check:", fetchError);
                throw fetchError;
            }

            // 2. Create a lookup set for efficient deduplication
            const existingSet = new Set(
                (existingRecords || []).map(r => 
                    `${r.isin}|${r.date}|${r.transaction_type}|${parseFloat(r.units).toFixed(4)}|${parseFloat(r.amount).toFixed(2)}`
                )
            );

            // 3. Filter transactions
            const filteredTransactions = transactions.filter(txn => {
                const key = `${txn.isin}|${txn.date}|${txn.transaction_type}|${parseFloat(txn.units).toFixed(4)}|${parseFloat(txn.amount).toFixed(2)}`;
                return !existingSet.has(key);
            });

            if (filteredTransactions.length === 0) {
                logEmitter.log("ℹ️ All parsed transactions are duplicates. Skipping insert.");
                return { success: true, count: 0, message: "No new transactions to save." };
            }

            logEmitter.log(`🚀 Successfully filtered. Saving ${filteredTransactions.length} new transactions to mf_raw_cas...`);

            const { error: insertError } = await supabase
                .from("mf_raw_cas")
                .insert(filteredTransactions);

            if (insertError) {
                console.error("Supabase Insert Error:", insertError);
                throw new Error(`Failed to save to database: ${insertError.message}`);
            }

            logEmitter.log(`🚀 Successfully processed and saved ${filteredTransactions.length} new transactions.`);
            return { success: true, count: filteredTransactions.length, message: `Successfully processed ${filteredTransactions.length} new transactions.` };

        } finally {
            lock.release();
        }
    } catch (err) {
        logEmitter.log(`❌ Gmail Process Error: ${err.message}`);
        throw err;
    } finally {
        await client.logout();
    }
}
