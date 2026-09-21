// GET /api/air-status
//
// The whole-home air-quality box: its five readings, already converted.
//
//   { success: true,
//     device: { temperature: 24.1, humidity: 48.4, co2: 415, voc: 0.01, ch2o: 0.002,
//               updatedAt: 1789974278870 },
//     units:  { temperature: '℃', humidity: '%', co2: 'ppm', voc: 'mg/m3', ch2o: 'mg/m3' },
//     raw:    [ { code: 'co2_value', value: 415, ... }, ... ] }
//
// A reading the box has not reported is null. `updatedAt` is the newest report
// time of the five (ms). When no air box is configured the reply is 404.
//
// Each number is converted with the `scale` of the box's own data model
// (reported number = value × 10^scale). If the model cannot be read, the scales
// confirmed in API Explorer on 21 Sep (智能空气盒子V3) are used instead.

import { applyCors, pickAirBox, getProperties, getThingModel, fail, failFromError } from '../lib/tuya-ir.js';

const READINGS = {
  temperature: { code: 'temp_current',   scale: 1, unit: '℃' },
  humidity:    { code: 'humidity_value', scale: 1, unit: '%' },
  co2:         { code: 'co2_value',      scale: 0, unit: 'ppm' },
  voc:         { code: 'voc_value',      scale: 3, unit: 'mg/m3' },
  ch2o:        { code: 'ch2o_value',     scale: 3, unit: 'mg/m3' },
};

// code → { scale, unit } from the data model; {} when it cannot be read.
function specsOf(model) {
  const out = {};
  for (const service of (model && model.services) || []) {
    for (const p of service.properties || []) {
      const spec = p.typeSpec || {};
      if (p.code && typeof spec.scale === 'number') out[p.code] = { scale: spec.scale, unit: spec.unit };
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET')) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method Not Allowed');

  try {
    const deviceId = pickAirBox(req.query && req.query.deviceId);
    if (!deviceId) return fail(res, 403, 'Device not allowed');

    const [raw, model] = await Promise.all([
      getProperties(deviceId),
      getThingModel(deviceId).catch(() => null),   // the fallback scales cover this
    ]);
    const specs = specsOf(model);

    const device = { updatedAt: null };
    const units = {};
    for (const [key, r] of Object.entries(READINGS)) {
      const point = raw.find(p => p.code === r.code);
      const spec = specs[r.code] || r;
      units[key] = spec.unit || r.unit;
      if (!point || typeof point.value !== 'number') { device[key] = null; continue; }
      // toFixed keeps 241 / 10 at 24.1 rather than 24.099999…
      device[key] = Number((point.value / 10 ** spec.scale).toFixed(spec.scale));
      if (typeof point.time === 'number' && point.time > (device.updatedAt || 0)) device.updatedAt = point.time;
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, device, units, raw });
  } catch (e) {
    return failFromError(res, e);
  }
}
