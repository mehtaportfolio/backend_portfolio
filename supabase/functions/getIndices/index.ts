import { serve } from "https://deno.land/std@0.177.0/http/server.ts"

const NSE_BASE = "https://www.nseindia.com/api/equity-stockIndices"

async function fetchNSE(index: string) {
  const url = `${NSE_BASE}?index=${encodeURIComponent(index)}`
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0", // Required
      "Accept": "application/json",
    },
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch ${index} (${res.status})`)
  }

  const data = await res.json()
  const info = data.data?.[0]
  if (!info) throw new Error(`No data for ${index}`)

  return {
    index,
    last: info.last,
    previousClose: info.previousClose,
  }
}

serve(async (_req) => {
  try {
    const midcap = await fetchNSE("NIFTY MIDCAP 100")
    const smallcap = await fetchNSE("NIFTY SMALLCAP 250")

    return new Response(JSON.stringify({ midcap, smallcap }), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})
