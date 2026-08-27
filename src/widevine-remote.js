// src/widevine-remote.js
import fetch from 'node-fetch';

// Widevine
const CDM_HOST = 'https://getwvkeys.cc/api/remotecdm/widevine';
const CDM_SECRET = 'getwvkeys';

// Chaser-CF (Cloudflare Bypass)
const CHASER_CF_URL = process.env.CHASER_CF_URL || 'https://chaser-cf-88vh.onrender.com';

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

export async function bypassCloudflare(url, proxy = null) {
  try {
    const response = await fetch(CHASER_CF_URL + '/solve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mode: 'waf-session',
        url,
        proxy: proxy ? {
          host: proxy.host,
          port: proxy.port,
          ...(proxy.username && { username: proxy.username }),
          ...(proxy.password && { password: proxy.password })
        } : undefined
      })
    });

    if (!response.ok) {
      throw new Error(`Chaser-CF error: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Cloudflare bypassed:', url);
    return {
      success: true,
      cookies: data.cookies,
      html: data.html,
      headers: data.headers
    };
  } catch (error) {
    console.error('❌ Chaser-CF error:', error.message);
    return null;
  }
}
