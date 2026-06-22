import express from 'express';
import { Fido2Lib } from 'fido2-lib';
import { randomBytes } from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { supabase } from '../db/supabaseClient.js';
import { fetchAllRows } from '../db/queries.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STORE_PATH = join(__dirname, '..', '..', 'webauthn_store.json');

let store = { users: {} };
try {
  if (fs.existsSync(STORE_PATH)) {
    store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) || { users: {} };
  }
} catch (err) {
  console.warn('Could not read webauthn store:', err.message);
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Failed to write webauthn store:', err.message);
  }
}

const f2l = new Fido2Lib({
  timeout: 60000,
  rpId: process.env.RP_ID || 'localhost',
  rpName: 'Portfolio Tracker',
  challengeSize: 64,
  attestation: 'none',
  cryptoParams: [-7, -257],
});

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64u) {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

// Verify provided password for email by checking user_details table
async function verifyPasswordForEmail(email, password) {
  const { data, error } = await fetchAllRows(supabase, 'user_details', {
    filters: [(q) => q.eq('user_email', email.toLowerCase())],
    limit: 1
  });
  if (error) throw error;
  const row = data && data[0];
  if (!row) return false;
  // Prefer master_password, fall back to user_password
  const expected = row.master_password || row.user_password;
  return expected === password;
}

// Registration challenge
router.post('/register-challenge', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const ok = await verifyPasswordForEmail(email, password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const userId = randomBytes(16);
    const user = {
      id: userId,
      name: email,
      displayName: email
    };

    const attOptions = await f2l.attestationOptions();

    attOptions.challenge = attOptions.challenge; // Buffer/Uint8Array
    attOptions.user = {
      id: userId,
      name: email,
      displayName: email
    };

    // store challenge for verification
    store.users[email] = store.users[email] || {};
    store.users[email].challenge = toBase64Url(attOptions.challenge);
    store.users[email].userId = toBase64Url(userId);
    saveStore();

    // Convert binary data to base64url strings for client
    const publicOptions = {
      ...attOptions,
      challenge: toBase64Url(attOptions.challenge),
      user: {
        ...attOptions.user,
        id: toBase64Url(attOptions.user.id)
      }
    };

    res.json(publicOptions);
  } catch (err) {
    console.error('register-challenge error', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify attestation and store credential
router.post('/verify-registration', async (req, res) => {
  try {
    const { email, attestation } = req.body;
    if (!email || !attestation) return res.status(400).json({ error: 'email and attestation required' });
    const saved = store.users[email];
    if (!saved || !saved.challenge) return res.status(400).json({ error: 'No challenge found for email' });

    // Convert incoming attestation fields to buffers
    const clientAttestation = {
      id: fromBase64Url(attestation.id),
      rawId: fromBase64Url(attestation.rawId),
      response: {
        attestationObject: fromBase64Url(attestation.response.attestationObject),
        clientDataJSON: fromBase64Url(attestation.response.clientDataJSON)
      },
      type: attestation.type
    };

    const expected = {
      challenge: fromBase64Url(saved.challenge),
      origin: req.headers.origin || `http://${req.hostname}`,
      factor: 'either'
    };

    const attResult = await f2l.attestationResult(clientAttestation, expected);

    // store credential
    const credId = attestation.rawId; // already base64url encoded from browser
    store.users[email].credential = {
      id: credId,
      publicKeyPem: attResult.authnrData.get('credentialPublicKeyPem'),
      credentialPublicKey: attResult.authnrData.get('credentialPublicKey'),
      publicKey: attResult.authnrData.get('credentialPublicKeyPem') || attResult.authnrData.get('credentialPublicKey'),
      counter: attResult.authnrData.get('signCount') || 0
    };
    saveStore();

    res.json({ success: true });
  } catch (err) {
    console.error('verify-registration error', err);
    res.status(400).json({ error: err.message });
  }
});

// Assertion challenge
router.post('/assertion-challenge', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const saved = store.users[email];
    if (!saved || !saved.credential) return res.status(404).json({ error: 'No credential registered' });

    const allowCred = [{ id: fromBase64Url(saved.credential.id), type: 'public-key', transports: ['internal'] }];
    const options = await f2l.assertionOptions();
    options.challenge = options.challenge;
    options.allowCredentials = allowCred;

    // save challenge
    store.users[email].assertionChallenge = toBase64Url(options.challenge);
    saveStore();

    const publicOptions = {
      ...options,
      challenge: toBase64Url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((cred) => ({
        ...cred,
        id: toBase64Url(cred.id)
      }))
    };

    res.json(publicOptions);
  } catch (err) {
    console.error('assertion-challenge error', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify assertion
router.post('/verify-assertion', async (req, res) => {
  try {
    const { email, assertion } = req.body;
    if (!email || !assertion) return res.status(400).json({ error: 'email and assertion required' });
    const saved = store.users[email];
    if (!saved || !saved.credential || !saved.assertionChallenge) return res.status(400).json({ error: 'Missing server state' });

    console.log('verify-assertion start', {
      email,
      assertionId: assertion.id,
      assertionRawIdLength: assertion.rawId?.length || null,
      savedCredentialId: saved.credential.id
    })

    const clientAssertion = {
      id: fromBase64Url(assertion.id),
      rawId: fromBase64Url(assertion.rawId),
      response: {
        authenticatorData: fromBase64Url(assertion.response.authenticatorData),
        clientDataJSON: fromBase64Url(assertion.response.clientDataJSON),
        signature: fromBase64Url(assertion.response.signature),
        userHandle: assertion.response.userHandle ? fromBase64Url(assertion.response.userHandle) : undefined
      },
      type: assertion.type
    };

    const expected = {
      challenge: fromBase64Url(saved.assertionChallenge),
      origin: req.headers.origin || `http://${req.hostname}`,
      factor: 'either',
      publicKey: saved.credential.publicKey,
      prevCounter: saved.credential.counter || 0
    };

    if (assertion.response.userHandle) {
      expected.userHandle = fromBase64Url(assertion.response.userHandle)
    }

    const authnResult = await f2l.assertionResult(clientAssertion, expected);

    // update counter
    store.users[email].credential.counter = authnResult.authnrData.get('signCount') || saved.credential.counter || 0;
    saveStore();

    res.json({ success: true });
  } catch (err) {
    console.error('verify-assertion error', err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
