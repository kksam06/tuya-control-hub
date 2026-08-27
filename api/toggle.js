const crypto = require('crypto');

export default async function handler(req, res) {
  // Enforce CORS so your GitHub Pages frontend can communicate with this API
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Or replace '*' with your specific GitHub Pages URL
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle browser preflight checks
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 1. Fetch Secure Environment Variables
  const CLIENT_ID = process.env.TUYA_CLIENT_ID;
  const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
  const DEVICE_ID = process.env.TUYA_DEVICE_ID;
  
  // Set your proper region endpoint server schema (e.g., US = tuyaus, EU = tuyaeu)
  const schema = "https://tuyaus.com"; 
  const timestamp = Date.now().toString();
  
  try {
    // 2. Step A: Get Signed Access Token from Tuya Cloud
    const tokenSignUrl = "/v1.0/token?grant_type=1";
    const signString1 = CLIENT_ID + timestamp + "GET\n" + crypto.createHash('sha256').update("").digest('hex') + "\n\n" + tokenSignUrl;
    const signature1 = crypto.createHmac('sha256', CLIENT_SECRET).update(signString1).digest('hex').toUpperCase();

    const tokenRes = await fetch(`${schema}${tokenSignUrl}`, {
      headers: { 'client_id': CLIENT_ID, 'sign': signature1, 't': timestamp, 'sign_method': 'HMAC-SHA256' }
    });
    const tokenData = await tokenRes.json();
    
    if (!tokenData.success) {
      return res.status(500).json({ error: 'Failed to acquire Tuya token', details: tokenData });
    }
    
    const accessToken = tokenData.result.access_token;

    // 3. Step B: Sign and Issue the Relay Command Payload
    const currentStatus = req.body.turnOn; // Receives boolean true/false from your website button
    const commandUrl = `/v1.0/devices/${DEVICE_ID}/commands`;
    const bodyPayload = JSON.stringify({
      commands: [{ code: "switch_1", value: currentStatus }]
    });
    
    const contentHash = crypto.createHash('sha256').update(bodyPayload).digest('hex');
    const signString2 = CLIENT_ID + accessToken + timestamp + "POST\n" + contentHash + "\n\n" + commandUrl;
    const signature2 = crypto.createHmac('sha256', CLIENT_SECRET).update(signString2).digest('hex').toUpperCase();

    const controlRes = await fetch(`${schema}${commandUrl}`, {
      method: 'POST',
      headers: {
        'client_id': CLIENT_ID,
        'access_token': accessToken,
        'sign': signature2,
        't': timestamp,
        'sign_method': 'HMAC-SHA256',
        'Content-Type': 'application/json'
      },
      body: bodyPayload
    });

    const finalResult = await controlRes.json();
    return res.status(200).json(finalResult);

  } catch (error) {
    return res.status(500).json({ error: 'Internal relay server error', message: error.message });
  }
}