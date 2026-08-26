import { URL as URLParser } from 'url';

const MEDIA_RE = /\.(?:m3u8|mpd|mp4|m4v|webm)(?:[?#]|$)|\/manifest(?:[/?]|$)|\/playlist(?:[/?]|$)|\/stream(?:[/?]|$)/i;
const SUB_RE = /\.(?:vtt|srt|ass|ssa|ttml)(?:[?#]|$)|\/subs?(?:[/?]|$)|subtitle|caption/i;
const JUNK_RE = /doubleclick|googlesyndication|google-analytics|googletagmanager|tracking|tracker|pixel|beacon|advert|banner|preroll|midroll|postroll|sample\.mp4|dummy\.mp4|blank\.mp4/i;

function resolveUrl(base, value) {
  if (!value) return null;
  let v = String(value).trim().replace(/&amp;/gi, '&').replace(/\\\//g, '/').replace(/\\u002f/gi, '/').replace(/\\u003a/gi, ':');
  v = v.replace(/[\\"'<>`,);]+$/g, '');
  if (/^(blob:|data:|javascript:|mailto:|#)/i.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return (/^http:/i.test(base || '') ? 'http:' : 'https:') + v;
  if (!base) return null;
  try { return new URLParser(v, base).href; } catch { return null; }
}

function key(url) {
  try { const u = new URLParser(url.startsWith('//') ? 'https:' + url : url); u.hash = ''; return u.href; } catch { return String(url).split('#')[0]; }
}
function quality(url, resolution = '') {
  const text = `${url} ${resolution}`.toLowerCase();
  const m = text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)p?(?:[^0-9]|$)/);
  return m ? `${m[1]}p` : 'unknown';
}
function qualityScore(label = '') {
  const n = Number.parseInt(String(label), 10);
  return Number.isFinite(n) ? n : 0;
}
function subtitleLanguage(url, label = '') {
  const m = `${url} ${label}`.match(/(?:^|[._-])(ar|en|fr|de|es|it|nl|pl|tr|pt|ru|ja|ko|zh)(?:[._-]|$)/i);
  return m ? m[1].toLowerCase() : null;
}
function linkMeta(url, referer) {
  const meta = { expiresAt: null, ttlSeconds: null, referer: referer || null, likelySigned: false };
  try {
    const u = new URLParser(url);
    const raw = ['expires', 'expire', 'expiry', 'exp', 'end', 'expires_at'].map((k) => u.searchParams.get(k)).find(Boolean);
    if (raw) { const n = Number(raw); const ms = n < 2e10 ? n * 1000 : n; if (Number.isFinite(ms)) { meta.expiresAt = new Date(ms).toISOString(); meta.ttlSeconds = Math.max(0, Math.round((ms - Date.now()) / 1000)); } }
    meta.likelySigned = ['token', 'sig', 'signature', 'expires', 'exp', 'auth'].some((k) => u.searchParams.has(k));
  } catch {}
  return meta;
}
function collect(text, base, found) {
  if (!text) return;
  const add = (raw) => { const u = resolveUrl(base, raw); if (u && /^https?:/i.test(u) && !JUNK_RE.test(u)) found.set(key(u), u); };
  const attr = /(?:src|href|data-(?:src|url|file|hls|mp4|m3u8|stream))\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(text))) add(m[1]);
  const urls = /(?:https?:)?\/\/[^\s"'<>`\\]+/gi;
  while ((m = urls.exec(text))) add(m[0]);
}
function parseAttrs(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
  return out;
}
function parseHls(manifest, base) {
  const variants = [], subtitles = [];
  const lines = String(manifest || '').split(/\r?\n/).map((x) => x.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(lines[i].slice(18)); const u = resolveUrl(base, lines[i + 1]);
      if (u) variants.push({ url: u, quality: quality(u, a.RESOLUTION), bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0), resolution: a.RESOLUTION || null, codecs: a.CODECS || null, type: 'hls' });
    } else if (lines[i].startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(lines[i].slice('#EXT-X-MEDIA:'.length)); const u = resolveUrl(base, a.URI);
      if (u && /SUBTITLES|CLOSED-CAPTIONS/i.test(a.TYPE || '')) subtitles.push({ url: u, language: a.LANGUAGE || subtitleLanguage(u, a.NAME) || null, label: a.NAME || a.LANGUAGE || 'subtitle', group: a['GROUP-ID'] || null, default: String(a.DEFAULT).toUpperCase() === 'YES', forced: String(a.FORCED).toUpperCase() === 'YES', type: 'hls' });
    }
  }
  return { variants, subtitles };
}
function parseDash(manifest, base) {
  const variants = [], subtitles = [];
  const mpdBase = resolveUrl(base, manifest.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)?.[1]) || base;
  for (const m of manifest.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)].map((x) => [x[1].toLowerCase(), x[2]]));
    const u = resolveUrl(mpdBase, m[2].match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)?.[1]) || mpdBase;
    if (u) variants.push({ url: u, quality: quality(u, attrs.height ? `${attrs.width || ''}x${attrs.height}` : ''), bandwidth: Number(attrs.bandwidth || 0), width: Number(attrs.width || 0), height: Number(attrs.height || 0), codecs: attrs.codecs || null, type: 'dash' });
  }
  for (const m of manifest.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)].map((x) => [x[1].toLowerCase(), x[2]]));
    if (!/text|subtitle|caption/i.test(`${attrs.contentType || ''} ${attrs.mimeType || ''}`)) continue;
    for (const u of m[2].matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)) { const abs = resolveUrl(mpdBase, u[1]); if (abs) subtitles.push({ url: abs, language: attrs.lang || subtitleLanguage(abs) || null, label: attrs.lang || 'subtitle', type: 'dash' }); }
  }
  return { variants, subtitles };
}

export async function runFallbackExtraction({ page, pageUrl, deep = false, quality: requestedQuality = 'auto', cookies = [], headers = {} }) {
  const found = new Map(), subtitles = new Map(), referers = new Map(), responseBodies = new Map(), mediaKeys = new Set();
  const diagnostics = { fallback: true, requestsObserved: 0, mediaRequests: 0, framesVisited: 0, framesAttached: 0, playClicked: false, tabsClicked: 0, lazyIframes: 0, strategies: [], timedOut: false, captchaSuspected: false, drmSuspected: false, mseDetected: false, responseMediaCandidates: 0, validatedCandidates: 0, validationCandidates: 0, mediaSignal: 'no-media-requests', proxyConfigured: false, proxyUsed: null, proxySwitched: false, proxyError: null, proxyErrors: [], fallbackAttempted: true, fallbackSucceeded: false };
  const add = (u, ref = pageUrl) => { const abs = resolveUrl(pageUrl, u); if (!abs || JUNK_RE.test(abs)) return; if (SUB_RE.test(abs)) subtitles.set(key(abs), { url: abs, language: subtitleLanguage(abs) || null, label: subtitleLanguage(abs) || 'subtitle', type: 'file' }); else if (MEDIA_RE.test(abs)) { found.set(key(abs), abs); referers.set(key(abs), ref); } };
  const onReq = (req) => { diagnostics.requestsObserved++; const u = req.url(); if (MEDIA_RE.test(u) || SUB_RE.test(u)) { const k = key(u); if (!mediaKeys.has(k)) { mediaKeys.add(k); diagnostics.mediaRequests++; } add(u, req.headers().referer || pageUrl); } };
  const onRes = async (res) => {
    try {
      const u = res.url();
      const ct = String(res.headers()['content-type'] || '').toLowerCase();
      if (MEDIA_RE.test(u) || SUB_RE.test(u) || /mpegurl|dash\+xml|video\//i.test(ct)) {
        add(u, pageUrl);
        diagnostics.responseMediaCandidates++;
        if (/mpegurl|dash\+xml|json|text\//i.test(ct)) {
          const body = await res.text().catch(() => '');
          responseBodies.set(key(u), body);
          if (/json|config|player|source|stream|media|video/i.test(`${ct} ${u}`) && body.length <= 2_000_000) {
            collect(body, u, found);
            if (/(?:https?:\/\/|\/\/)[^\s"'<>`\\]+/i.test(body)) diagnostics.strategies.push('fallback-json-media-config');
          }
        }
      }
    } catch {}
  };
  page.on('request', onReq); page.on('response', onRes);
  if (cookies?.length) await page.context().addCookies(cookies).catch(() => {});
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let round = 0; round < (deep ? 3 : 2); round++) {
      for (const frame of page.frames().slice(0, deep ? 20 : 10)) {
        diagnostics.framesVisited = Math.max(diagnostics.framesVisited, page.frames().length);
        try { collect(await frame.content(), frame.url() || pageUrl, found); } catch {}
        try {
          const urls = await frame.evaluate(() => [...document.querySelectorAll('video,audio,source,track,iframe,[data-src],[data-url],[data-file],[data-hls],[data-m3u8]')].flatMap((x) => [x.currentSrc, x.src, x.getAttribute?.('src'), x.getAttribute?.('data-src'), x.getAttribute?.('data-url'), x.getAttribute?.('data-file'), x.getAttribute?.('data-hls'), x.getAttribute?.('data-m3u8')].filter(Boolean)));
          urls.forEach((u) => add(u, frame.url() || pageUrl));
        } catch {}
      }
      diagnostics.strategies.push(`fallback-round-${round + 1}`);
      await page.evaluate(() => { window.scrollBy(0, 500); document.querySelectorAll('video').forEach((v) => { try { v.muted = true; void v.play(); } catch {} }); }).catch(() => {});
      await new Promise((r) => setTimeout(r, deep ? 2500 : 1200));
    }
    for (const u of [...found.values()]) {
      if (!/\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$)|manifest|playlist/i.test(u)) continue;
      try {
        const res = await page.context().request.get(u, { timeout: 9000, failOnStatusCode: false, maxRedirects: 5, headers: { referer: referers.get(key(u)) || pageUrl } });
        const body = responseBodies.get(key(u)) || await res.text();
        if (/^\s*#EXTM3U/m.test(body)) { const p = parseHls(body, u); p.variants.forEach((v) => found.set(key(v.url), v.url)); p.subtitles.forEach((s) => subtitles.set(key(s.url), s)); }
        if (/<MPD[\s>]/i.test(body)) { const p = parseDash(body, u); p.variants.forEach((v) => found.set(key(v.url), v.url)); p.subtitles.forEach((s) => subtitles.set(key(s.url), s)); }
      } catch {}
    }
  } finally { page.off('request', onReq); page.off('response', onRes); }
  const candidates = [...found.values()].map((url) => ({ url, quality: quality(url), bandwidth: 0, type: /\.m3u8|manifest|playlist/i.test(url) ? 'hls' : /\.mpd/i.test(url) ? 'dash' : /\.webm/i.test(url) ? 'webm' : 'mp4', referer: referers.get(key(url)) || pageUrl }));
  const variants = [];
  const toValidate = candidates.slice(0, 16);
  const validateCandidate = async (v) => {
    let validation = { valid: false, status: null, contentType: null, reason: 'not-checked' };
    try {
      const requestHeaders = { ...headers, referer: v.referer || pageUrl };
      if (v.type === 'mp4' || v.type === 'webm') requestHeaders.range = 'bytes=0-2047';
      const res = await page.context().request.get(v.url, { timeout: 5000, failOnStatusCode: false, maxRedirects: 5, headers: requestHeaders });
      const ct = String(res.headers()['content-type'] || '').toLowerCase(); const body = (v.type === 'hls' || v.type === 'dash' || v.type === 'mp4' || v.type === 'webm') ? await res.body().then((b) => b.subarray(0, 4096)).catch(() => Buffer.alloc(0)) : Buffer.alloc(0); const text = body.toString('utf8');
      const validType = v.type === 'hls' ? (/mpegurl|application\/vnd.apple.mpegurl/i.test(ct) || /^\s*#EXTM3U/m.test(text)) : v.type === 'dash' ? (/dash\+xml|application\/xml/i.test(ct) || /<MPD[\s>]/i.test(text)) : /^(video\/|application\/octet-stream)/i.test(ct) || (v.type === 'mp4' && text.includes('ftyp')) || (v.type === 'webm' && text.includes('webm'));
      validation = { valid: res.status() >= 200 && res.status() < 400 && validType, status: res.status(), contentType: ct || null, reason: res.status() < 200 || res.status() >= 400 ? `http-${res.status()}` : (validType ? null : 'content-type-or-signature') };
    } catch (e) { validation.reason = e.code || e.message; }
    v.validation = validation; return v;
  };
  for (let i = 0; i < toValidate.length; i += 4) {
    const batch = await Promise.all(toValidate.slice(i, i + 4).map(validateCandidate));
    for (const v of batch) { if (v.validation.valid) { variants.push(v); diagnostics.validatedCandidates++; } }
  }
  diagnostics.validationCandidates = toValidate.length;
  diagnostics.fallbackSucceeded = Boolean(variants.length);
  diagnostics.mediaSignal = diagnostics.validatedCandidates > 0 ? 'validated' : diagnostics.mediaRequests > 0 ? 'media-requests-without-accepted-primary' : 'no-media-requests';
  variants.sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality) || Number(b.bandwidth || 0) - Number(a.bandwidth || 0));
  const picked = variants.find((v) => requestedQuality === 'auto' || v.quality === requestedQuality) || variants[0];
  return { success: !!picked, primaryUrl: picked?.url || null, urls: { m3u8: variants.filter((v) => v.type === 'hls').map((v) => v.url), mp4: variants.filter((v) => v.type === 'mp4').map((v) => v.url), webm: variants.filter((v) => v.type === 'webm').map((v) => v.url), mpd: variants.filter((v) => v.type === 'dash').map((v) => v.url), segment: [], other: [] }, variants, subtitles: [...subtitles.values()], qualities: [...new Set(variants.map((v) => v.quality).filter((x) => x !== 'unknown'))], duration: 0, strategy: diagnostics.strategies.join('+'), quality: requestedQuality, validated: !!picked, linkMeta: picked ? linkMeta(picked.url, picked.referer) : null, error: picked ? null : 'Fallback extractor found no validated public media URL', errorCode: picked ? null : 'FALLBACK_NO_VALIDATED_STREAM', diagnostics, source: 'vd-pro-fallback', pageTitle: await page.title().catch(() => null), completedCleanly: true };
}
