import fetch from 'node-fetch';

const CDM_HOST = process.env.WIDEVINE_CDM_URL || 'https://getwvkeys.cc/api/remotecdm/widevine';
const CHASER_CF_URL = process.env.CHASER_CF_URL || 'https://chaser-cf-88vh.onrender.com';
const DEFAULT_TIMEOUT_MS = 20000;

function boundedTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) ? Math.min(120000, Math.max(3000, n)) : fallback;
}

function hostOf(value) {
  try { return new URL(value).hostname; } catch { return 'unknown-host'; }
}

async function requestJson(url, options, timeoutValue) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(timeoutValue));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    if (!data || typeof data !== 'object') throw new Error('INVALID_JSON_RESPONSE');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getWidevineKeys(pssh, licenseUrl, referer = null) {
  const secret = String(process.env.WIDEVINE_CDM_SECRET || '').trim();
  if (!secret || !pssh || !licenseUrl) return null;
  try {
    const data = await requestJson(CDM_HOST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Secret': secret },
      body: JSON.stringify({ pssh, license_url: licenseUrl, referer })
    }, process.env.WIDEVINE_TIMEOUT_MS);
    return Array.isArray(data.keys) ? data.keys : null;
  } catch (error) {
    console.error('Widevine request failed', { host: hostOf(CDM_HOST), error: error.name === 'AbortError' ? 'TIMEOUT' : error.message });
    return null;
  }
}

export async function bypassCloudflare(url, proxy = null) {
  if (!url) return null;
  try {
    const data = await requestJson(`${CHASER_CF_URL.replace(/\/+$/, '')}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    }, process.env.CHASER_CF_TIMEOUT_MS || 30000);
    return { success: true, cookies: data.cookies, html: data.html, headers: data.headers };
  } catch (error) {
    console.error('Cloudflare helper failed', { host: hostOf(CHASER_CF_URL), error: error.name === 'AbortError' ? 'TIMEOUT' : error.message });
    return null;
  }
}
