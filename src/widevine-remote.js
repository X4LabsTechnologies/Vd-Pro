// src/widevine-remote.js
import fetch from 'node-fetch';

// Remote CDM مجاني من GetWVKeys
const CDM_HOST = 'https://getwvkeys.cc/api/remotecdm/widevine';
const CDM_SECRET = 'getwvkeys';

export async function getWidevineKeys(pssh, licenseUrl, referer = null) {
  try {
    const response = await fetch(CDM_HOST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Secret': CDM_SECRET
      },
      body: JSON.stringify({
        pssh,
        license_url: licenseUrl,
        referer
      })
    });

    if (!response.ok) {
      throw new Error(`CDM error: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Keys extracted:', data.keys?.length, 'keys');
    return data.keys || null;
  } catch (error) {
    console.error('❌ Widevine error:', error.message);
    return null;
  }
} 
