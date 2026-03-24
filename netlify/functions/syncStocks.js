import fetch from "node-fetch";

export async function handler(event, context) {
  try {
    const url = "https://script.google.com/macros/s/AKfycbzWdqz09c7SC9lavvKsQ0RMMMYnwcNBVpGRNUllY-5L1hkpWXrKVChD_3BUh1aX9W5G/exec";
    const response = await fetch(url);
    const data = await response.json();

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
}
