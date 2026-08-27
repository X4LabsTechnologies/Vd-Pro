// src/widevine-remote.js
import fetch from 'node-fetch';

const CDM_API_URL = process.env.CDM_API_URL || '';
const CDM_API_KEY = process.env.CDM_API_KEY || '';

// دالة جاهزة لاستخدامها في أي مكان
export async function getWidevineKeys(pssh, licenseUrl, referer = null) {
  if (!CDM_API_URL) {
    console.warn('⚠️ CDM_API_URL not configured');
    return null;
  }

  try {
    const response = await fetch(CDM_API_URL + '/getkeys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CDM_API_KEY ? { 'Authorization': `Bearer ${CDM_API_KEY}` } : {})
      },
      body: JSON.stringify({
        pssh,
        license_url: licenseUrl,
        referer
      })
    });

    if (!response.ok) {
      throw new Error(`CDM API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Widevine keys extracted:', data.keys?.length, 'keys');
    return data.keys || null;
  } catch (error) {
    console.error('❌ Widevine error:', error.message);
    return null;
  }
}
