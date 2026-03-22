
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.backend') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const accounts = ['PM', 'PDM', 'PSM', 'BDM'];
  console.log('Checking accounts:', accounts);

  const { data, error } = await supabase
    .from('stock_transactions')
    .select('account_name, quantity, sell_date')
    .in('account_name', accounts);

  if (error) {
    console.error('Error fetching transactions:', error);
    return;
  }

  console.log('Total transactions found:', data.length);
  
  const active = data.filter(t => !t.sell_date);
  console.log('Active transactions found:', active.length);

  const { data: stockMaster, error: masterError } = await supabase
    .from('stock_master')
    .select('stock_name, cmp');

  if (masterError) {
    console.error('Error fetching stock master:', masterError);
    return;
  }

  const cmpMap = {};
  stockMaster.forEach(m => {
    cmpMap[m.stock_name] = m.cmp;
  });

  let totalMarketValue = 0;
  let zeroCmpCount = 0;
  
  const { data: fullActive, error: fullError } = await supabase
    .from('stock_transactions')
    .select('stock_name, quantity, account_name')
    .in('account_name', accounts)
    .is('sell_date', null);

  fullActive.forEach(t => {
    const cmp = cmpMap[t.stock_name] || 0;
    if (cmp === 0) zeroCmpCount++;
    totalMarketValue += (t.quantity || 0) * cmp;
  });

  console.log('Total Market Value calculated:', totalMarketValue);
  console.log('Positions with zero CMP:', zeroCmpCount);
  console.log('Total Active positions checked:', fullActive.length);
}

check();
