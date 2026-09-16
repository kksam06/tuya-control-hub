// Shared code for the IR controller endpoints (api/ir-status.js, api/ir-send.js).
// The plug endpoints (status.js, toggle.js) do not use this and are unaffected.
//
// ENVIRONMENT VARIABLES (Vercel → Settings → Environment Variables)
// Reuses the ones already set up for the plug, plus the IR box's ID:
//   TUYA_CLIENT_ID                Access ID of the Tuya project
//   TUYA_CLIENT_SECRET            Access Secret of that project
//   TUYA_DEVICE_ID_IR_CONTROLLER  the IR box's device ID (comma-separate for several)
//
// The IR box must be in the SAME Tuya project as those keys. If it is not,
// Tuya answers 1106 "permission deny" and the endpoints return 403.

import crypto from 'crypto';

// Same Singapore data center the plug endpoints use, and the one the IR box is in.
const BASE_URL = 'https://openapi-sg.iotbing.com';

// Kept identical to the plug endpoints' list.
const ALLOWED_ORIGINS = [
  'https://kksam06.github.io',
  'https://iqballlshahh.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// Tuya codes meaning "that token is no longer good": refresh once and retry.
const TOKEN_ERRORS = [1010, 1011, 1012];

function readConfig() {
  const accessId = (process.env.TUYA_CLIENT_ID || '').trim();
  const secret = (process.env.TUYA_CLIENT_SECRET || '').trim();
  const deviceIds = (process.env.TUYA_DEVICE_ID_IR_CONTROLLER || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const missing = [];
  if (!accessId) missing.push('TUYA_CLIENT_ID');
  if (!secret) missing.push('TUYA_CLIENT_SECRET');
  if (!deviceIds.length) missing.push('TUYA_DEVICE_ID_IR_CONTROLLER');
  if (missing.length) {
    const e = new Error('Missing environment variable(s): ' + missing.join(', '));
    e.status = 500;
    throw e;
  }
  return { accessId, secret, deviceIds };
}

// Same signing formula as the working plug endpoints:
//   accessId [+ accessToken] + t + METHOD\n + sha256(body) + \n\n + url
export function sign(accessId, secret, token, t, method, url, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', secret)
    .update(accessId + token + t + method + '\n' + bodyHash + '\n\n' + url)
    .digest('hex')
    .toUpperCase();
}

// Kept while this serverless instance stays warm, so polling every few seconds
// does not also request a new token every few seconds.
let cfg = null;
let cachedToken = null;   // { token, expiresAt }

async function callTuya(method, url, token, body) {
  const t = Date.now().toString();
  const headers = {
    client_id: cfg.accessId,
    sign: sign(cfg.accessId, cfg.secret, token, t, method, url, body),
    t,
    sign_method: 'HMAC-SHA256',
  };
  if (token) headers.access_token = token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE_URL + url, { method, headers, body: body || undefined });
  try {
    return await res.json();
  } catch {
    return { success: false, code: res.status, msg: 'Non-JSON response (HTTP ' + res.status + ')' };
  }
}

function tuyaError(json) {
  const e = new Error(json.msg || 'Tuya request failed');
  e.tuyaCode = json.code;
  return e;
}

async function getToken(force) {
  // A minute's margin so a token never expires part-way through a request.
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }
  const json = await callTuya('GET', '/v1.0/token?grant_type=1', '', '');
  if (!json.success) throw tuyaError(json);
  cachedToken = {
    token: json.result.access_token,
    expiresAt: Date.now() + Number(json.result.expire_time || 0) * 1000,
  };
  return cachedToken.token;
}

async function tuyaRequest(method, url, bodyObject) {
  if (!cfg) cfg = readConfig();
  const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
  let json = await callTuya(method, url, await getToken(false), body);
  if (!json.success && TOKEN_ERRORS.includes(json.code)) {
    json = await callTuya(method, url, await getToken(true), body);
  }
  if (!json.success) throw tuyaError(json);
  return json.result;
}

// Every data point the box reports: [{ code, value, time, dp_id, type }, ...]
export async function getProperties(deviceId) {
  const result = await tuyaRequest('GET',
    '/v2.0/cloud/thing/' + encodeURIComponent(deviceId) + '/shadow/properties');
  return (result && result.properties) || [];
}

// Everything the box is told goes through its `ir_send` data point, as a JSON
// command. `properties` is a JSON *string* whose `ir_send` is itself a JSON
// string — two layers on purpose; that is the form Tuya accepted.
async function writeIrSend(deviceId, command) {
  return tuyaRequest('POST',
    '/v2.0/cloud/thing/' + encodeURIComponent(deviceId) + '/shadow/properties/issue',
    { properties: JSON.stringify({ ir_send: JSON.stringify(command) }) });
}

// Fire a learned code.
//
// The box only transmits when the code arrives wrapped the way the Tuya app
// sends it. Confirmed from the device logs on 16 Sep: a bare code reached the
// box but nothing fired; this exact wrapper, sent from API Explorer, turned the
// fan on. `key1` is "1" followed by the code — without the "1" the value is
// the plain base64 code, so the "1" is a prefix, not part of the code.
// What the "1" means is not documented anywhere we found; it is mirrored as-is.
// Callers pass the plain code; the wrapping lives only here.
export async function sendIr(deviceId, code) {
  return writeIrSend(deviceId, { control: 'send_ir', head: '', key1: '1' + code, type: 0, delay: 300 });
}

// Learning mode on / off. These are the two commands the Tuya app itself sends
// around a learn (device logs, 16 Sep 19:08:52 and 19:08:54). While learning,
// the box reports the captured code in `ir_study_code`; learning a button this
// way from the cloud, then replaying it with sendIr, switched the fan on.
export async function startLearning(deviceId) {
  return writeIrSend(deviceId, { control: 'study' });
}
export async function stopLearning(deviceId) {
  return writeIrSend(deviceId, { control: 'study_exit' });
}

// Which device to act on. The caller may name one, but ONLY from the configured
// list: these keys can reach every device in the Tuya project.
export function pickDevice(requested) {
  if (!cfg) cfg = readConfig();
  const id = String(requested || '').trim();
  if (!id) return cfg.deviceIds[0];
  return cfg.deviceIds.includes(id) ? id : null;
}

// Returns true when the request was a browser preflight and has been answered.
export function applyCors(req, res, methods) {
  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods + ', OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// Errors in the shape the web app already reads: success:false plus `error`.
export function fail(res, status, error, extra) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ success: false, error, ...(extra || {}) });
}

export function failFromError(res, e) {
  if (e.status) return fail(res, e.status, e.message);
  // 1106: the keys work, but their Tuya project cannot see this device.
  const status = e.tuyaCode === 1106 ? 403 : 502;
  return fail(res, status, e.message, { tuyaCode: e.tuyaCode ?? null });
}
