// supabase/functions/update-fund-master/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // service role key required for updates
);

serve(async () => {
  try {
    // 1️⃣ Fetch NAV data
    const res = await fetch("https://www.amfiindia.com/spages/NAVAll.txt");
    if (!res.ok) throw new Error(`Failed to fetch NAV data: ${res.status}`);
    const text = await res.text();

    // 2️⃣ Parse rows
    const lines = text.split("\n").filter(l => l.trim() !== "");
    const dataLines = lines.slice(2); // skip headers

    const navMap: Record<string, { schemeName: string; cmp: number; lcp: number }> = {};

    for (const line of dataLines) {
      const cols = line.split(";");
      if (cols.length < 6) continue;

      const isin = cols[1]?.trim();
      const schemeName = cols[3]?.trim();
      const nav = parseFloat(cols[4]);

      if (!isin || isNaN(nav)) continue;

      navMap[isin] = {
        schemeName,
        cmp: nav,
        lcp: nav, // if you want last close price separate, adjust here
      };
    }

    // 3️⃣ Update fund_master (one by one with error logging)
    let updated = 0;
    for (const isin in navMap) {
      const { cmp, lcp, schemeName } = navMap[isin];
      const { error } = await supabase
        .from("fund_master")
        .update({ cmp, lcp })
        .or(`isin.eq.${isin},fund_full_name.eq.${schemeName}`);

      if (error) {
        console.error(`Failed to update fund ${isin} (${schemeName}):`, error.message);
      } else {
        updated++;
      }
    }

    return new Response(
      JSON.stringify({ success: true, updated }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
