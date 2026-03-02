
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env.backend') });

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);

async function run() {
  const { data, error } = await supabase
    .from('bank_transactions')
    .select('account_name, bank_name, account_type, txn_date, amount')
    .order('txn_date', { ascending: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  const latestBalances = {};
  data.forEach((txn) => {
    const key = `${txn.account_name}___${txn.bank_name}___${txn.account_type}`;
    if (!latestBalances[key]) {
      latestBalances[key] = txn;
    }
  });

  const summary = {
    Savings: 0,
    Demat: 0,
  };

  const byAccount = {};

  Object.values(latestBalances).forEach((txn) => {
    const type = String(txn.account_type || '').toLowerCase();
    const amount = parseFloat(txn.amount) || 0;
    const name = txn.account_name;

    if (!byAccount[name]) byAccount[name] = 0;
    byAccount[name] += amount;

    if (type === 'savings' || type === 'Savings') {
      summary.Savings += amount;
    } else if (type === 'demat' || type === 'Demat') {
      summary.Demat += amount;
    }
  });

  console.log('--- Summary by Account Type ---');
  console.log(summary);
  console.log('--- Summary by Account Name ---');
  console.log(byAccount);
  console.log('--- Total ---');
  console.log(summary.Savings + summary.Demat);
}

run();
