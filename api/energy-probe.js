// What can Tuya actually tell us about a metering plug's ENERGY?
//
// The device's own status gives cur_power / cur_voltage / cur_current live, and
// `add_ele` — which is NOT a meter reading. Measured on a3cdd345f119f3d440jbjx
// on 2026-10-15: add_ele sat at 10 Wh for seven minutes under a steady 21.1 W
// load (1.8 Wh), then jumped; and the Smart Life app showed Total 1.48 kWh
// against add_ele's 0.011 kWh. So the increments arrive in lumps and the total
// lives somewhere else.
//
// Smart Life shows Today / Total / per-month / per-day, so Tuya is keeping that
// account server-side. Half-hourly billing needs to know which of its endpoints
// this project's plan and API version will actually answer — and the refusals
// are as much of the finding as the successes, which is why this reports every
// attempt instead of stopping at the first that works.
//
// Read-only: GET only, no command is ever sent. Delete it once the question is
// settled; it exists to be answered, not to be kept.
import { rawGet, applyCors, fail } from '../lib/tuya-ir.js';

// Tuya's own clock for this project is Singapore; a "day" boundary that does not
// match the app's would make the daily totals impossible to line up with the
// half-hourly prices, so ask in the same zone the prices are quoted in.
const TZ_OFFSET_MIN = 8 * 60;
const sgNow = () => new Date(Date.now() + TZ_OFFSET_MIN * 60_000);
const p2 = (n) => String(n).padStart(2, '0');
const yyyymmdd = (d) => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
const yyyymm = (d) => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}`;

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET')) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method Not Allowed');

  // Only this project's own devices. The probe reports specifications and shadow
  // properties, which is more than /api/status gives away, and the endpoint has
  // no auth in front of it — so the set of things it can be asked about is the
  // set the deployment already names in its own environment.
  const known = ['TUYA_DEVICE_ID', 'TUYA_DEVICE_ID_IR_CONTROLLER', 'TUYA_DEVICE_ID_AIR_BOX', 'TUYA_DEVICE_ID_PLUG']
    .flatMap((k) => String(process.env[k] || '').split(',').map((x) => x.trim()).filter(Boolean));
  const deviceId = String(req.query?.deviceId || '').trim() || known[0];
  if (!deviceId) return fail(res, 400, 'deviceId is required');
  if (!known.includes(deviceId)) {
    return fail(res, 403, 'That device is not one this deployment is configured for');
  }
  // One code is worth asking about: add_ele is the only energy DP this plug
  // reports. Left overridable because another metering device may name it
  // differently (total_forward_energy on some models).
  const code = String(req.query?.code || 'add_ele').trim();

  const now = sgNow();
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);
  const today = yyyymmdd(now);
  const since = yyyymmdd(weekAgo);
  const d = encodeURIComponent(deviceId);
  const c = encodeURIComponent(code);
  // Epoch milliseconds, which the report-log endpoints take instead of a date.
  // Thirty days, not seven: a seven-day query came back with 34 rows and
  // has_more:false, which looked like a retention limit and was not -- the plug
  // simply was not drawing power the rest of the week. Retention and idleness
  // produce the same empty result, so the window has to outrun the usage.
  const msNow = Date.now();
  const msBack = msNow - 30 * 86400_000;
  const msWeekAgo = msNow - 8 * 86400_000;

  // Ordered roughly by how useful the answer would be. `want` says what we would
  // do with it, so a reader of the output knows why the attempt was made.
  const CANDIDATES = [
    { want: 'running total — poll it on each half hour and subtract',
      path: `/v1.0/devices/${d}/statistics/total?code=${c}` },
    { want: 'per-hour totals — the closest thing to half-hourly Tuya may hold',
      path: `/v1.0/devices/${d}/statistics/hours?code=${c}&start_time=${today}00&end_time=${today}23` },
    { want: 'per-day totals — what the Smart Life bar chart draws',
      path: `/v1.0/devices/${d}/statistics/days?code=${c}&start_day=${since}&end_day=${today}` },
    { want: 'per-month totals',
      path: `/v1.0/devices/${d}/statistics/months?code=${c}&start_month=${yyyymm(weekAgo)}&end_month=${yyyymm(now)}` },
    { want: 'every add_ele report with its timestamp — enough to bucket by half hour ourselves',
      path: `/v2.0/cloud/thing/${d}/report-logs?codes=${c}&start_time=${msBack}&end_time=${msNow}&size=100` },
    { want: 'the same, on the older device-log API',
      path: `/v1.0/devices/${d}/logs?type=7&codes=${c}&start_time=${msBack}&end_time=${msNow}&size=100` },
    { want: 'the newer iot-03 report log',
      path: `/v1.0/iot-03/devices/${d}/report-logs?codes=${c}&start_time=${msBack}&end_time=${msNow}&size=100` },
    { want: 'RETENTION: any event at all from 8-30 days ago -- rows here mean Tuya keeps more than a week',
      path: `/v2.0/cloud/thing/${d}/report-logs?start_time=${msBack}&end_time=${msWeekAgo}&size=20` },
    { want: 'which DPs this device exposes at all, and their ranges',
      path: `/v1.0/devices/${d}/specifications` },
    { want: 'the thing-model properties, where a total may be hiding under another name',
      path: `/v2.0/cloud/thing/${d}/shadow/properties` },
  ];

  const tried = [];
  for (const { path, want } of CANDIDATES) {
    try {
      const json = await rawGet(path);
      tried.push({
        path, want,
        success: json.success === true,
        code: json.code ?? null,
        msg: json.msg ?? null,
        // Truncated: this is read by a person deciding which endpoint to build
        // on, and a thousand log rows would bury the one fact they are after.
        result: json.success ? trim(json.result) : null,
      });
    } catch (e) {
      tried.push({ path, want, success: false, code: null, msg: String(e?.message || e), result: null });
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    success: true,
    deviceId, code,
    askedAt: new Date().toISOString(),
    usable: tried.filter((t) => t.success).map((t) => t.want),
    tried,
  });
}

// Keep the shape, lose the bulk: the first few rows of a list say what the rows
// look like, which is the whole question here.
function trim(result) {
  const cap = (s) => (s.length > 1200 ? s.slice(0, 1200) + ' …(truncated)' : s);
  try {
    if (Array.isArray(result)) {
      return { count: result.length, first: result.slice(0, 6) };
    }
    if (result && Array.isArray(result.result)) {
      return { ...result, count: result.result.length, result: result.result.slice(0, 6) };
    }
    if (result && Array.isArray(result.logs)) {
      const ts = result.logs.map((l) => Number(l.event_time)).filter(Boolean);
      const span = ts.length ? {
        newest: new Date(Math.max(...ts)).toISOString(),
        oldest: new Date(Math.min(...ts)).toISOString(),
        spanHours: Math.round((Math.max(...ts) - Math.min(...ts)) / 36000) / 100,
      } : null;
      const rows = result.logs.length > 6
        ? result.logs.slice(0, 3).concat(result.logs.slice(-3))
        : result.logs;
      return { ...result, count: result.logs.length, span, logs: rows };
    }
    return JSON.parse(cap(JSON.stringify(result)));
  } catch {
    return result;
  }
}
