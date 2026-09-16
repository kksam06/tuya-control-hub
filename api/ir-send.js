// POST /api/ir-send        body: { "code": "<learned IR code>" }
//
// Writes the code to the IR box's `ir_send` data point, which makes it
// transmit, exactly what made the fan react in API Explorer.

import { applyCors, pickDevice, sendIr, fail, failFromError } from '../lib/tuya-ir.js';

// A learned code is base64. Anything else is refused before it reaches Tuya.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CODE_LENGTH = 8192;

export default async function handler(req, res) {
  if (applyCors(req, res, 'POST')) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method Not Allowed');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(res, 400, 'Body must be JSON'); }
  }
  const code = body && body.code;
  if (typeof code !== 'string' || !code || code.length > MAX_CODE_LENGTH || !BASE64.test(code)) {
    return fail(res, 400, 'code must be a base64 IR code');
  }

  try {
    const deviceId = pickDevice(body.deviceId);
    if (!deviceId) return fail(res, 403, 'Device not allowed');

    await sendIr(deviceId, code);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true });
  } catch (e) {
    return failFromError(res, e);
  }
}
