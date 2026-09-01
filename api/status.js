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
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  // Handle browser preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Only allow GET
  if (req.method !== 'GET') {
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
      error: 'Missing Tuya environment variables'
    });
  }

  // ==========================================
  // TUYA US REGION
  // ==========================================

  const schema = 'https://openapi.tuyaus.com';

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

    const signString =
      CLIENT_ID +
      timestamp +
      'GET\n' +
      emptyBodyHash +
      '\n\n' +
      tokenSignUrl;

    const signature = crypto
      .createHmac('sha256', CLIENT_SECRET)
      .update(signString)
      .digest('hex')
      .toUpperCase();

    const tokenRes = await fetch(
      `${schema}${tokenSignUrl}`,
      {
        method: 'GET',

        headers: {
          client_id: CLIENT_ID,
          sign: signature,
          t: timestamp,
          sign_method: 'HMAC-SHA256'
        }
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.success) {

      console.error(
        'Tuya token error:',
        tokenData
      );

      return res.status(500).json({
        error: 'Failed to acquire Tuya token',
        details: tokenData
      });
    }

    const accessToken =
      tokenData.result.access_token;


    // ==========================================
    // 2. ASK TUYA FOR DEVICE STATUS
    // ==========================================

    const statusUrl =
      `/v1.0/devices/${DEVICE_ID}/status`;

    const statusTimestamp =
      Date.now().toString();

    const emptyHash = crypto
      .createHash('sha256')
      .update('')
      .digest('hex');

    const statusSignString =
      CLIENT_ID +
      accessToken +
      statusTimestamp +
      'GET\n' +
      emptyHash +
      '\n\n' +
      statusUrl;

    const statusSignature =
      crypto
        .createHmac(
          'sha256',
          CLIENT_SECRET
        )
        .update(statusSignString)
        .digest('hex')
        .toUpperCase();


    const statusRes = await fetch(
      `${schema}${statusUrl}`,
      {
        method: 'GET',

        headers: {
          client_id: CLIENT_ID,
          access_token: accessToken,
          sign: statusSignature,
          t: statusTimestamp,
          sign_method: 'HMAC-SHA256'
        }
      }
    );


    const statusData =
      await statusRes.json();


    console.log(
      'Tuya device status:',
      statusData
    );


    if (
      !statusRes.ok ||
      !statusData.success
    ) {

      return res.status(500).json({
        error: 'Failed to get device status',
        details: statusData
      });
    }


    // ==========================================
    // 3. RETURN STATUS TO FRONTEND
    // ==========================================

    return res.status(200).json({
      success: true,
      status: statusData.result
    });


  } catch (error) {

    console.error(
      'Status server error:',
      error
    );

    return res.status(500).json({
      error: 'Internal status server error',
      message: error.message
    });
  }
}