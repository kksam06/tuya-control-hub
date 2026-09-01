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

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }


  // ==========================================
  // TUYA ENVIRONMENT VARIABLES
  // ==========================================

  const CLIENT_ID =
    process.env.TUYA_CLIENT_ID;

  const CLIENT_SECRET =
    process.env.TUYA_CLIENT_SECRET;

  const DEVICE_ID =
    process.env.TUYA_DEVICE_ID;


  if (
    !CLIENT_ID ||
    !CLIENT_SECRET ||
    !DEVICE_ID
  ) {

    return res.status(500).json({
      error: 'Missing Tuya environment variables'
    });

  }


  // ==========================================
  // TUYA SINGAPORE DATA CENTER
  // ==========================================

  const schema =
    'https://openapi.tuyaus.com';


  try {

    // ==========================================
    // 1. GET ACCESS TOKEN
    // ==========================================

    const timestamp =
      Date.now().toString();

    const tokenSignUrl =
      '/v1.0/token?grant_type=1';

    const emptyBodyHash =
      crypto
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

    const signature =
      crypto
        .createHmac(
          'sha256',
          CLIENT_SECRET
        )
        .update(signString)
        .digest('hex')
        .toUpperCase();


    const tokenRes =
      await fetch(
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


    const tokenData =
      await tokenRes.json();


    console.log(
      'Tuya token response:',
      tokenData
    );


    if (!tokenData.success) {

      return res.status(500).json({
        error: 'Failed to acquire Tuya token',
        details: tokenData
      });

    }


    const accessToken =
      tokenData.result.access_token;


    // ==========================================
    // 2. GET DEVICE STATUS
    // ==========================================

    const statusUrl =
      `/v1.0/devices/${DEVICE_ID}/status`;

    const statusTimestamp =
      Date.now().toString();

    const statusBodyHash =
      crypto
        .createHash('sha256')
        .update('')
        .digest('hex');


    const statusSignString =
      CLIENT_ID +
      accessToken +
      statusTimestamp +
      'GET\n' +
      statusBodyHash +
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


    const statusRes =
      await fetch(
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
    // 3. EXTRACT DEVICE VALUES
    // ==========================================

    const statusList =
      statusData.result || [];


    const findValue =
      (code) => {

        const item =
          statusList.find(
            x => x.code === code
          );

        return item
          ? item.value
          : null;
      };


    const rawPower =
      findValue('cur_power');

    const rawVoltage =
      findValue('cur_voltage');

    const rawCurrent =
      findValue('cur_current');

    const rawEnergy =
      findValue('add_elec');

    const relayStatus =
      findValue('relay_status');


    // ==========================================
    // 4. APPLY TUYA SCALES
    // ==========================================

    const power =
      rawPower !== null
        ? rawPower / 10
        : null;

    const voltage =
      rawVoltage !== null
        ? rawVoltage / 10
        : null;

    const current =
      rawCurrent !== null
        ? rawCurrent
        : null;

    const energy =
      rawEnergy !== null
        ? rawEnergy / 1000
        : null;


    // ==========================================
    // 5. RETURN CLEAN DATA TO GITHUB PAGE
    // ==========================================

    return res.status(200).json({

      success: true,

      device: {

        power: power,

        voltage: voltage,

        current: current,

        energy: energy,

        relayStatus: relayStatus

      },

      raw: statusList

    });


  } catch (error) {

    console.error(
      'Status server error:',
      error
    );


    return res.status(500).json({

      error:
        'Internal status server error',

      message:
        error.message

    });

  }

}