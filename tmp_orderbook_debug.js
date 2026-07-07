import dotenv from 'dotenv';
dotenv.config();
import { SmartAPI } from 'smartapi-javascript';
import { authenticator } from 'otplib';

const clientId = (process.env.ANGEL_CLIENT_ID || '').trim().toUpperCase();
const password = (process.env.ANGEL_PASSWORD || '').trim();
const totpSecret = (process.env.ANGEL_TOTP_SECRET || '').trim().replace(/\s/g, '').toUpperCase();

if (!clientId || !password || !totpSecret) {
  console.error('Missing env vars');
  process.exit(1);
}

const otp = authenticator.generate(totpSecret);
const api = new SmartAPI({ api_key: process.env.ANGEL_API_KEY.trim() });
const response = await api.generateSession(clientId, password, otp);
console.log('login response keys:', Object.keys(response));
console.log('login response:', JSON.stringify(response, null, 2));

if (response && response.status && response.data) {
  api.jwtToken = response.data.jwtToken;
  api.access_token = response.data.jwtToken;
  const orderResp = await api.getOrderBook();
  console.log('orderbook response keys:', Object.keys(orderResp));
  console.log('orderbook response:', JSON.stringify(orderResp, null, 2));
} else {
  console.error('Login failed:', response);
}
