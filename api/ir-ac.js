// /api/ir-ac — air conditioners through Tuya's IR code library.
//
// One file, many actions: Vercel's Hobby plan allows 12 functions per project,
// and a file per action would use them all. Every action takes the IR box as
// `deviceId` (optional; the first configured box by default) and only works on
// a box listed in TUYA_DEVICE_ID_IR_CONTROLLER.
//
// GET  ?action=remotes                          remotes on the box
// GET  ?action=brands                           AC brands Tuya knows
// GET  ?action=indexes&brandId=2782             a brand's code sets
// GET  ?action=brand-of&remoteIndex=2000420     brand(s) using a code set
// GET  ?action=status&remoteId=…                last state sent through a remote
// GET  ?action=learned&learningTime=…           code captured since learning began
// GET  ?action=match-result&token=…             smart-matching candidates
// POST { action: "command", remoteId, power, mode, temp, wind, swing? }
// POST { action: "add-remote", remoteName, brandId, brandName, remoteIndex }
// POST { action: "delete-remote", remoteId }
// POST { action: "learn", on: true | false }    → { learningTime } when on
// POST { action: "match", code }                → { token, expiresIn }
//
// Tuya's values: mode 0 cool · 1 heat · 2 auto · 3 fan · 4 dry;
//                wind 0 auto · 1 low · 2 mid · 3 high; power and swing 0 / 1.

import {
  applyCors, pickDevice, fail, failFromError, CATEGORY_AC,
  listRemotes, remoteBelongs, listBrands, listRemoteIndexes, brandsOfIndex,
  addRemote, deleteRemote, sendAcScene, getAcStatus,
  setLearningState, getLearnedCode, startMatching, getMatchingResult,
} from '../lib/tuya-ir.js';

const REMOTE_ID = /^[A-Za-z0-9]{1,64}$/;
const TOKEN = /^[A-Za-z0-9]{1,128}$/;
// A learned code as Tuya's learning API returns it: hex, two bytes per pulse.
// A Mitsubishi AC's is ~2,000 characters; the cap only stops absurd input.
const HEX_CODE = /^(?:[0-9a-fA-F]{2}){8,16384}$/;

// A positive whole number in JavaScript's safe range (code-set indexes reach 445,414,039).
function positiveInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function intIn(v, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
// A label for Tuya's records: trimmed, no control characters, capped.
function label(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return s && s.length <= max ? s : null;
}
function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return body && typeof body === 'object' ? body : null;
}
const ok = (res, data) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ success: true, ...data });
};

// A remote id must be well formed AND belong to this box — never act on another
// device's remote just because its id was sent.
async function checkRemote(res, deviceId, remoteId) {
  if (typeof remoteId !== 'string' || !REMOTE_ID.test(remoteId)) {
    fail(res, 400, 'remoteId is missing or malformed');
    return false;
  }
  if (!(await remoteBelongs(deviceId, remoteId))) {
    // The web reads this to say "that remote no longer exists — choose again".
    fail(res, 404, 'Remote not found on this IR controller', { reason: 'remote-not-found' });
    return false;
  }
  return true;
}

async function handleGet(req, res, deviceId) {
  const q = req.query || {};
  switch (q.action) {
    case 'remotes': {
      const remotes = (await listRemotes(deviceId)).map(r => ({
        remoteId: r.remote_id, name: r.remote_name, categoryId: r.category_id,
        brandId: r.brand_id, brandName: r.brand_name, remoteIndex: r.remote_index,
      }));
      return ok(res, { remotes });
    }
    case 'brands': {
      const brands = (await listBrands(deviceId, CATEGORY_AC))
        .map(b => ({ brandId: b.brand_id, brandName: b.brand_name }));
      return ok(res, { brands });
    }
    case 'indexes': {
      const brandId = positiveInt(q.brandId);
      if (!brandId) return fail(res, 400, 'brandId must be a positive integer');
      const { indexes, total } = await listRemoteIndexes(deviceId, CATEGORY_AC, brandId);
      return ok(res, { remoteIndexes: indexes, total });
    }
    case 'brand-of': {
      const remoteIndex = positiveInt(q.remoteIndex);
      if (!remoteIndex) return fail(res, 400, 'remoteIndex must be a positive integer');
      const brands = (await brandsOfIndex(deviceId, CATEGORY_AC, remoteIndex))
        .map(b => ({ brandId: b.brand_id, brandName: b.brand_name }));
      return ok(res, { brands });
    }
    case 'status': {
      if (!(await checkRemote(res, deviceId, q.remoteId))) return;
      const s = (await getAcStatus(deviceId, q.remoteId)) || {};
      // Tuya sends every value as a string ("24"); the web gets numbers.
      const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
      return ok(res, {
        state: { power: num(s.power), mode: num(s.mode), temp: num(s.temp),
                 wind: num(s.wind), swing: num(s.swing) },
      });
    }
    case 'learned': {
      const learningTime = positiveInt(q.learningTime);
      if (!learningTime) return fail(res, 400, 'learningTime must be a positive integer');
      return ok(res, { code: await getLearnedCode(deviceId, learningTime) });
    }
    case 'match-result': {
      if (typeof q.token !== 'string' || !TOKEN.test(q.token)) return fail(res, 400, 'token is missing or malformed');
      const r = (await getMatchingResult(deviceId, q.token)) || {};
      return ok(res, {
        hasNext: !!r.has_next, progress: r.progress ?? null,
        remoteIndexes: Array.isArray(r.remote_indexs) ? r.remote_indexs : [],
      });
    }
    default:
      return fail(res, 400, 'Unknown action');
  }
}

async function handlePost(req, res, deviceId, body) {
  switch (body.action) {
    case 'command': {
      if (!(await checkRemote(res, deviceId, body.remoteId))) return;
      const scene = {
        power: intIn(body.power, 0, 1),
        mode: intIn(body.mode, 0, 4),
        temp: intIn(body.temp, 16, 30),
        wind: intIn(body.wind, 0, 3),
      };
      const bad = Object.keys(scene).filter(k => scene[k] === null);
      if (bad.length) return fail(res, 400, 'Out of range or missing: ' + bad.join(', '));
      if (body.swing !== undefined) {
        const swing = intIn(body.swing, 0, 1);
        if (swing === null) return fail(res, 400, 'swing must be 0 or 1');
        scene.swing = swing;
      }
      await sendAcScene(deviceId, body.remoteId, scene);
      return ok(res, {});
    }
    case 'add-remote': {
      const remote = {
        categoryId: CATEGORY_AC,
        remoteName: label(body.remoteName, 32),
        brandId: positiveInt(body.brandId),
        brandName: label(body.brandName, 64),
        remoteIndex: positiveInt(body.remoteIndex),
      };
      const bad = Object.keys(remote).filter(k => remote[k] === null);
      if (bad.length) return fail(res, 400, 'Out of range or missing: ' + bad.join(', '));
      return ok(res, { remoteId: await addRemote(deviceId, remote) });
    }
    case 'delete-remote': {
      if (!(await checkRemote(res, deviceId, body.remoteId))) return;
      await deleteRemote(deviceId, body.remoteId);
      return ok(res, {});
    }
    case 'learn': {
      if (typeof body.on !== 'boolean') return fail(res, 400, 'on must be true or false');
      const t = await setLearningState(deviceId, body.on);
      return ok(res, body.on ? { learningTime: t } : {});
    }
    case 'match': {
      if (typeof body.code !== 'string' || !HEX_CODE.test(body.code)) {
        return fail(res, 400, 'code must be a hex learned code');
      }
      const r = (await startMatching(deviceId, CATEGORY_AC, body.code)) || {};
      if (!r.token) return fail(res, 502, 'Tuya returned no matching token');
      return ok(res, { token: r.token, expiresIn: r.expire_time ?? null });
    }
    default:
      return fail(res, 400, 'Unknown action');
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST')) return;
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'Method Not Allowed');

  try {
    let body = null;
    if (req.method === 'POST') {
      body = readBody(req);
      if (!body) return fail(res, 400, 'Body must be a JSON object');
    }
    const requested = req.method === 'POST' ? body.deviceId : (req.query && req.query.deviceId);
    const deviceId = pickDevice(requested);
    if (!deviceId) return fail(res, 403, 'Device not allowed');

    return req.method === 'GET'
      ? await handleGet(req, res, deviceId)
      : await handlePost(req, res, deviceId, body);
  } catch (e) {
    return failFromError(res, e);
  }
}
