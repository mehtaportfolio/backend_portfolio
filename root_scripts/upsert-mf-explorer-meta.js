// scripts/upsert-mf-explorer-meta.js
// Description: Fetch metadata from local API and upsert into Supabase table `mf_explorer_funds`.
// Requirements:
// - env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role recommended for upsert)
// - table schema as provided earlier
// - node >= 18

import 'dotenv/config';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const META_API = process.env.MF_META_API || 'http://localhost:3001/funds/meta';

async function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceKey) {
    return createClient(url, serviceKey, { auth: { persistSession: false } });
  }
  // Fallback: reuse project's Supabase client (must contain service role key)
  try {
    const mod = await import('../supabaseClient.js');
    return mod.supabase;
  } catch (e) {
    console.error('Supabase credentials not found. Set env vars or ensure supabaseClient.js exports a service-role client.');
    process.exit(1);
  }
}

function unique(arr) {
  return Array.from(new Set(arr));
}

async function main() {
  const res = await fetch(META_API);
  if (!res.ok) {
    console.error('Failed to fetch meta:', res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  const funds = Array.isArray(data.funds) ? data.funds : [];

  // Normalize to target shape
  const rows = funds
    .filter((f) => f.amfi_code && f.category && f.amc_name && (f.scheme_name || f.fund_full_name))
    .map((f) => ({
      amfi_code: String(f.amfi_code),
      category: String(f.category),
      amc_name: String(f.amc_name),
      scheme_name: String(f.scheme_name || f.fund_full_name),
      active: true,
    }));

  const supabase = await getSupabase();

  // Batch upserts to avoid payload limits
  const chunkSize = 1000;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('mf_explorer_funds')
      .upsert(chunk, { onConflict: 'amfi_code', ignoreDuplicates: false });

    if (error) {
      console.error('Upsert error at chunk', i / chunkSize, error);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});