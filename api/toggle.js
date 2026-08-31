const crypto = require('crypto');

export default async function handler(req, res) {
  // ==========================================
  // CORS
  // ==========================================

  const allowedOrigin = 'https://kksam06.github.io';

  res.setHeader(
    'Access-Control-Allow-Origin',
    allowedOrigin
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  // Browser preflight request
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }

  // ==========================================
  // TUYA ENVIRONMENT VARIABLES
  // ==========================================

  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID = process.env.TUYA_DEVICE_ID;

 if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID) {
  return res.status(500).json({
    error: 'Missing Tuya environment variables',
    checks: {
      clientId: !!CLIENT_ID,
      clientSecret: !!CLIENT_SECRET,
      deviceId: !!DEVICE_ID
    }
  });
}

  // Tuya US region
const schema = "https://openapi-sg.iotbing.com";

  try {
    // ==========================================
    // 1. GET TUYA ACCESS TOKEN
    // ==========================================

    const timestamp = Date.now().toString();

    const tokenSignUrl =
      '/v1.0/token?grant_type=1';

    const emptyBodyHash = crypto
      .createHash('sha256')
      .update('')
      .digest('hex');

    const signString1 =
      CLIENT_ID +
      timestamp +
      'GET\n' +
      emptyBodyHash +
      '\n\n' +
      tokenSignUrl;

    const signature1 = crypto
      .createHmac('sha256', CLIENT_SECRET)
      .update(signString1)
      .digest('hex')
      .toUpperCase();

    const tokenRes = await fetch(
      `${schema}${tokenSignUrl}`,
      {
        method: 'GET',
        headers: {
          client_id: CLIENT_ID,
          sign: signature1,
          t: timestamp,
          sign_method: 'HMAC-SHA256'
        }
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.success) {
      console.error('Tuya token error:', tokenData);

      return res.status(500).json({
        error: 'Failed to acquire Tuya token',
        details: tokenData
      });
    }

    const accessToken =
      tokenData.result.access_token;


    // ==========================================
    // 2. READ FRONTEND REQUEST
    // ==========================================

    const {
      turnOn,
      durationMinutes
    } = req.body;

    if (typeof turnOn !== 'boolean') {
      return res.status(400).json({
        error: 'turnOn must be true or false'
      });
    }


    // ==========================================
    // 3. SEND COMMAND TO TUYA
    // ==========================================

    const commandUrl =
      `/v1.0/devices/${DEVICE_ID}/commands`;

    const bodyPayload = JSON.stringify({
      commands: [
        {
          code: 'switch_1',
          value: turnOn
        }
      ]
    });

    const contentHash = crypto
      .createHash('sha256')
      .update(bodyPayload)
      .digest('hex');

    // Use a fresh timestamp for this request
    const commandTimestamp =
      Date.now().toString();

    const signString2 =
      CLIENT_ID +
      accessToken +
      commandTimestamp +
      'POST\n' +
      contentHash +
      '\n\n' +
      commandUrl;

    const signature2 = crypto
      .createHmac('sha256', CLIENT_SECRET)
      .update(signString2)
      .digest('hex')
      .toUpperCase();

    const controlRes = await fetch(
      `${schema}${commandUrl}`,
      {
        method: 'POST',

        headers: {
          client_id: CLIENT_ID,
          access_token: accessToken,
          sign: signature2,
          t: commandTimestamp,
          sign_method: 'HMAC-SHA256',
          'Content-Type': 'application/json'
        },

        body: bodyPayload
      }
    );

    const finalResult =
      await controlRes.json();

    console.log(
      'Tuya response:',
      finalResult
    );

    if (
      !controlRes.ok ||
      !finalResult.success
    ) {
      return res.status(500).json({
        error: 'Tuya command failed',
        details: finalResult
      });
    }

    return res.status(200).json({
      success: true,
      turnOn,
      durationMinutes,
      tuya: finalResult
    });

  } catch (error) {

    console.error(
      'Relay server error:',
      error
    );

    return res.status(500).json({
      error: 'Internal relay server error',
      message: error.message
    });
  }
}