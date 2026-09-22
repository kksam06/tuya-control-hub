// GET /api/ir-status
//
// Temperature, humidity, and the most recently learned IR code, in the same
// { success, device, raw } shape as /api/status:
//
//   { success: true,
//     device: { temperature: 25.2, humidity: 46, learnedAt: 1789468770829, online: true },
//     raw:    [ { code: 'temp_current', value: 252, ... }, ... ] }
//
// `online` is Tuya's own word on whether the box is connected (null if it gives
// none). The readings alone cannot tell: Tuya serves the last values of a box
// that has gone offline.
//
// `raw` includes `ir_study_code`: after teaching a button in the Tuya app, that
// is where its code appears, ready to be replayed through /api/ir-send.

import { applyCors, pickDevice, getProperties, getOnline, fail, failFromError } from '../lib/tuya-ir.js';

// Confirmed from the IR box's live status: temperature arrives x10, humidity as-is.
const TEMP_DIVISOR = 10;

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET')) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method Not Allowed');

  try {
    const deviceId = pickDevice(req.query && req.query.deviceId);
    if (!deviceId) return fail(res, 403, 'Device not allowed');

    const [raw, online] = await Promise.all([
      getProperties(deviceId),
      getOnline(deviceId).catch(() => null),   // the readings still come back without it
    ]);
    const valueOf = (code) => {
      const point = raw.find(p => p.code === code);
      return point ? point.value : null;
    };
    const timeOf = (code) => {
      const point = raw.find(p => p.code === code);
      return point ? point.time : null;
    };
    const temp = valueOf('temp_current');
    const humidity = valueOf('humidity_value');

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      device: {
        temperature: typeof temp === 'number' ? temp / TEMP_DIVISOR : null,
        humidity: typeof humidity === 'number' ? humidity : null,
        learnedAt: timeOf('ir_study_code'),
        online,
      },
      raw,
    });
  } catch (e) {
    return failFromError(res, e);
  }
}
