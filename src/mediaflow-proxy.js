import { URL as URLParser } from 'url';

const DEFAULT_PROXY_URL = 'https://mediaflow-proxy-light-37xr.onrender.com';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function cleanBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isHlsUrl(value = '') {
  return /\.m3u8(?:[?#]|$)|\/manifest(?:[/?]|$)|\/playlist(?:[/?]|$)/i.test(String(value));
}

export function mediaFlowProxyConfig(env = process.env) {
  const baseUrl = cleanBase(env.MEDIAFLOW_PROXY_URL || DEFAULT_PROXY_URL);
  const password = String(env.MEDIAFLOW_PROXY_PASSWORD || env.MEDIAFLOW_API_PASSWORD || env.APP__AUTH__API_PASSWORD || '').trim();
  const userAgent = String(env.MEDIAFLOW_USER_AGENT || DEFAULT_USER_AGENT).trim();
  const enabled = Boolean(baseUrl && password);
  return { enabled, baseUrl, password, userAgent };
}

export function buildMediaFlowHlsUrl(rawUrl, { referer = null, env = process.env } = {}) {
  if (!rawUrl || /\/proxy\/hls\/manifest\.m3u8\?/i.test(String(rawUrl)) || !/^https?:\/\//i.test(String(rawUrl)) || !isHlsUrl(rawUrl)) return null;
  const cfg = mediaFlowProxyConfig(env);
  if (!cfg.enabled) return null;
  const params = new URLSearchParams({ d: String(rawUrl), api_password: cfg.password, 'h_user-agent': cfg.userAgent });
  if (referer) params.set('h_referer', String(referer));
  return `${cfg.baseUrl}/proxy/hls/manifest.m3u8?${params.toString()}`;
}

export function applyMediaFlowProxy(result, { env = process.env } = {}) {
  if (!result || typeof result !== 'object') return result;
  if (result.linkMeta?.proxyType === 'mediaflow-hls') return result;
  const cfg = mediaFlowProxyConfig(env);
  if (!cfg.enabled) return result;
  const rewrite = (url, referer) => buildMediaFlowHlsUrl(url, { referer, env });
  const originalPrimary = result.primaryUrl;
  const primaryVariant = (result.variants || []).find((v) => v?.url === originalPrimary) || (result.variants || []).find((v) => v?.type === 'hls' && v?.url);
  const primaryReferer = result.linkMeta?.referer || primaryVariant?.referer || null;
  const proxiedPrimary = rewrite(originalPrimary, primaryReferer);
  if (proxiedPrimary) {
    result.primaryUrl = proxiedPrimary;
    result.linkMeta = {
      ...(result.linkMeta || {}),
      originalUrl: originalPrimary,
      proxyUrl: proxiedPrimary,
      proxyType: 'mediaflow-hls',
      proxyConfigured: true,
      referer: primaryReferer || result.linkMeta?.referer || null
    };
  }
  if (result.urls?.m3u8) {
    result.urls.m3u8 = result.urls.m3u8.map((url) => rewrite(url, primaryReferer) || url);
  }
  if (Array.isArray(result.variants)) {
    result.variants = result.variants.map((variant) => {
      if (variant?.type !== 'hls' && !isHlsUrl(variant?.url)) return variant;
      const raw = variant.url;
      const proxied = rewrite(raw, variant.referer || primaryReferer);
      return proxied ? { ...variant, url: proxied, originalUrl: raw, proxyUrl: proxied, proxyType: 'mediaflow-hls' } : variant;
    });
  }
  return result;
}

export function isMediaFlowProxyConfigured(env = process.env) {
  return mediaFlowProxyConfig(env).enabled;
}
