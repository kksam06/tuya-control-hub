// Half-hourly energy for one metering plug.
//
// `add_ele` is an INCREMENT, not a meter: each report carries the Wh used since
// the previous one. Drawing power, the plug reports every ~1801 s; idle, it can
// take hours to accumulate the 1 Wh it thinks worth sending. The series is
// therefore IRREGULAR by nature, and one reading means `this much energy, spread
// over the gap behind it` -- never `this much at this instant`. That is why the
// raw event times go back untouched: only the caller knows which clock half
// hours it wants them spread across, and getting that wrong is invisible in the
// data but wrong in the bill.
//
// Tuya keeps device logs about 7 days. Measured 2026-10-15: a 8-to-30-day window
// held not one event of any kind, while 6-to-8 days back was full of them, so the
// cut-off is deletion rather than an idle plug. Anything older than a week exists
// only if someone kept it.
import { rawGet, applyCors, fail, failFromError } from '../lib/tuya-ir.js';

const MAX_DAYS = 7;      // past this Tuya has nothing, so asking is a lie to the caller
const PAGE = 100;        // the endpoint's own ceiling
const MAX_PAGES = 5;     // 500 reports is ~10x a busy week; a runaway loop is the worse bug

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET')) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method Not Allowed');

  const deviceId = String(req.query?.deviceId || '').trim() || process.env.TUYA_DEVICE_ID;
  if (!deviceId) return fail(res, 400, 'deviceId is required');
  // Overridable because another metering model may name its energy DP otherwise.
  const code = String(req.query?.code || 'add_ele').trim();
  const days = Math.min(MAX_DAYS, Math.max(1, Number(req.query?.days) || MAX_DAYS));

  const to = Date.now();
  const from = to - days * 86400_000;
  const d = encodeURIComponent(deviceId);
  const c = encodeURIComponent(code);

  try {
    const logs = [];
    let rowKey = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `/v2.0/cloud/thing/${d}/report-logs?codes=${c}&start_time=${from}&end_time=${to}&size=${PAGE}`
              + (rowKey ? `&last_row_key=${encodeURIComponent(rowKey)}` : '');
      const json = await rawGet(q);
      if (!json.success) return fail(res, 502, tuyaMessage(json), { tuyaCode: json.code ?? null });
      const r = json.result || {};
      for (const l of r.logs || []) {
        const t = Number(l.event_time), wh = Number(l.value);
        if (Number.isFinite(t) && Number.isFinite(wh)) logs.push({ t, wh });
      }
      if (!r.has_more || !r.last_row_key) break;
      rowKey = r.last_row_key;
    }
    // Oldest first: everything downstream walks time forwards, and an increment
    // only means anything next to the reading before it.
    logs.sort((a, b) => a.t - b.t);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, deviceId, code, from, to, logs });
  } catch (e) {
    return failFromError(res, e);
  }
}

// Tuya's own words for this one point at the device (`No permissions`) when the
// thing actually missing is a service subscription on the project.
function tuyaMessage(json) {
  if (json.code === 28841101) return 'This Tuya project cannot read device logs';
  return json.msg || `Tuya refused it (code ${json.code})`;
}
