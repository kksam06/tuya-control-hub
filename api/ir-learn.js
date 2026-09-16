// POST /api/ir-learn        body: { "action": "start" }  or  { "action": "exit" }
//
// Puts the IR box into learning mode, or takes it out of it.
//
// Learning a button, end to end:
//   1. POST { action: "start" }        → { success: true, previousLearnedAt }
//   2. press the button on the real remote, aimed at the box
//   3. poll GET /api/ir-status until device.learnedAt !== previousLearnedAt;
//      the `ir_study_code` entry in `raw` then holds the new code
//   4. POST { action: "exit" }
//   5. replay it any time with POST /api/ir-send { code }
//
// `previousLearnedAt` is the box's own timestamp for the code it already held,
// read just before learning starts. Waiting for that value to CHANGE avoids
// comparing the browser's clock with Tuya's, which need not agree.

import {
  applyCors, pickDevice, getProperties, startLearning, stopLearning, fail, failFromError,
} from '../lib/tuya-ir.js';

export default async function handler(req, res) {
  if (applyCors(req, res, 'POST')) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method Not Allowed');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(res, 400, 'Body must be JSON'); }
  }
  const action = body && body.action;
  if (action !== 'start' && action !== 'exit') {
    return fail(res, 400, 'action must be "start" or "exit"');
  }

  try {
    const deviceId = pickDevice(body.deviceId);
    if (!deviceId) return fail(res, 403, 'Device not allowed');
    res.setHeader('Cache-Control', 'no-store');

    if (action === 'exit') {
      await stopLearning(deviceId);
      return res.status(200).json({ success: true });
    }

    const raw = await getProperties(deviceId);
    const learned = raw.find(p => p.code === 'ir_study_code');
    await startLearning(deviceId);
    return res.status(200).json({
      success: true,
      previousLearnedAt: learned ? learned.time : null,
    });
  } catch (e) {
    return failFromError(res, e);
  }
}
