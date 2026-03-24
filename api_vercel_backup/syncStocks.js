export default async function handler(req, res) {
  try {
    const url = "https://script.google.com/macros/s/AKfycbzWdqz09c7SC9lavvKsQ0RMMMYnwcNBVpGRNUllY-5L1hkpWXrKVChD_3BUh1aX9W5G/exec";

    const response = await fetch(url);
    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*"); // ✅ fix CORS
    res.status(200).json(data);
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: err.message });
  }
}
