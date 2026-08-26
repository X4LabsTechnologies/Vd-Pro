/**
 * Vd-Pro v4.5.0 — Extraction engine upgrade (same public API)
 *
 * Extraction-only improvements:
 * - Multi-round play + force HTML5 video.play()
 * - waitForResponse for m3u8/mpd/mp4 while interacting
 * - Generic watch/server/episode tab clicks (any language labels)
 * - Deeper iframe harvest + lazy iframe activation
 * - Base64 / escaped URL recovery from scripts
 * - Second harvest after interaction window
 * - Same endpoints, same result shape, no DRM/CAPTCHA bypass
 */

import express from 'express';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import cors from 'cors';
import { config } from 'dotenv';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import Redis from 'ioredis';
import Queue from 'bull';
import { MongoClient, ObjectId } from 'mongodb';
import axios from 'axios';
import crypto from 'crypto';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import * as prometheus from 'prom-client';
import { URL as URLParser } from 'url';
import dns from 'dns/promises';
import bcrypt from 'bcrypt';
import swaggerUi from 'swagger-ui-express';
import { runFallbackExtraction } from './src/fallback-extractor.js';
import { applyMediaFlowProxy, isMediaFlowProxyConfigured } from './src/mediaflow-proxy.js';

config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/vd-pro';
const PROXY_ENV = process.env.PROXIES || process.env.VD_PROXY_URLS || '';
const SINGLE_PROXY_ENV = process.env.PROXY_URL || process.env.VD_PROXY_URL || '';
const PROXIES = [...new Set([...PROXY_ENV.split(','), SINGLE_PROXY_ENV].map((p) => p.trim()).filter(Boolean))];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';

function envMs(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
const HARD_EXTRACT_MS = envMs('HARD_EXTRACT_MS', 110000, 10000, 15 * 60 * 1000);
const HARD_SEARCH_MS = envMs('HARD_SEARCH_MS', 30000, 5000, 10 * 60 * 1000);
const NAV_TIMEOUT_MS = envMs('NAV_TIMEOUT_MS', 45000, 5000, 5 * 60 * 1000);
const MEDIA_IDLE_WAIT_MS = envMs('MEDIA_IDLE_WAIT_MS', 8000, 1000, 30000);
const JOB_LOCK_MS = HARD_EXTRACT_MS + 45000;
const FALLBACK_BUDGET_MS = envMs('FALLBACK_BUDGET_MS', 30000, 5000, 90000);
const JOB_PROCESS_TIMEOUT_DEFAULT_MS = Math.max(HARD_EXTRACT_MS + FALLBACK_BUDGET_MS + 15000, HARD_SEARCH_MS + 15000);
const JOB_PROCESS_TIMEOUT_MS = envMs('JOB_PROCESS_TIMEOUT_MS', JOB_PROCESS_TIMEOUT_DEFAULT_MS, 15000, 15 * 60 * 1000);
const WATCHDOG_INTERVAL_MS = Math.max(15000, parseInt(process.env.WATCHDOG_INTERVAL_MS || '15000', 10));
const WATCHDOG_MAX_AGE_MS = Math.max(HARD_EXTRACT_MS, HARD_SEARCH_MS) + 30000;
const BROWSER_POOL_COUNT = Math.max(1, Math.min(4, parseInt(process.env.BROWSER_POOL_COUNT || '1', 10)));
const BROWSER_CONTEXTS_PER_POOL = Math.max(1, Math.min(4, parseInt(process.env.BROWSER_CONTEXTS_PER_POOL || '2', 10)));
let startupReady = false;
let startupError = null;
let startupReadyPromiseResolve;
let startupReadyPromiseReject;
const startupReadyPromise = new Promise((resolve, reject) => {
  startupReadyPromiseResolve = resolve;
  startupReadyPromiseReject = reject;
});

if (NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET.length < 32)) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters in production');
  process.exit(1);
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-secret-change-me-in-production-min-32-chars';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const metrics = {
  httpDuration: new prometheus.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  extractionDuration: new prometheus.Histogram({
    name: 'extraction_duration_seconds',
    help: 'Extract',
    labelNames: ['status'],
    buckets: [5, 10, 20, 30, 45, 60, 90, 120]
  }),
  sourceSuccess: new prometheus.Counter({ name: 'source_success_total', help: 'ok' }),
  sourceFailure: new prometheus.Counter({
    name: 'source_failure_total',
    help: 'fail',
    labelNames: ['reason']
  }),
  cacheHits: new prometheus.Counter({ name: 'cache_hits_total', help: 'cache', labelNames: ['level'] })
};
Object.values(metrics).forEach((m) => {
  try {
    prometheus.register.registerMetric(m);
  } catch (e) {}
});

function withTimeout(promise, ms, code = 'EXTRACTION_TIMEOUT') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(code);
      err.code = code;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let mongoClient = null;
let db = null;

async function connectDatabase() {
  try {
    mongoClient = new MongoClient(MONGODB_URL, {
      maxPoolSize: 30,
      minPoolSize: 3,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 10000,
      retryWrites: true
    });
    await mongoClient.connect();
    db = mongoClient.db('vd-pro');
    for (const col of ['users', 'extractions', 'cache', 'sessions', 'failed_jobs', 'diagnostics']) {
      try {
        await db.createCollection(col);
      } catch (e) {}
    }
    await Promise.all([
      db.collection('extractions').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('users').createIndex({ apiKey: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('cache').createIndex({ contentHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ userId: 1 })
    ]);
    logger.info('MongoDB connected');
    return true;
  } catch (e) {
    logger.error({ error: e.message }, 'MongoDB failed');
    return false;
  }
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (t) => Math.min(t * 50, 2000),
  enableReadyCheck: true,
  connectTimeout: 10000,
  commandTimeout: 5000
});
redis.on('error', (e) => logger.warn({ error: e.message }, 'Redis'));
redis.on('connect', () => logger.info('Redis connected'));

class SSRFValidator {
  static PRIVATE = [
    /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./, /^169\.254\./, /^0\.0\.0\.0$/, /^::1$/,
    /^fc00:/i, /^fd[0-9a-f]{2}:/i, /^fe80:/i, /^ff00:/i,
    /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-9])\./
  ];
  static isPrivate(host) {
    if (!host) return true;
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return this.PRIVATE.some((p) => p.test(h));
  }
  static async validate(urlString) {
    try {
      if (!urlString || typeof urlString !== 'string') return { valid: false, reason: 'URL required' };
      if (urlString.length > 2048) return { valid: false, reason: 'URL too long' };
      const url = new URLParser(urlString);
      if (!['http:', 'https:'].includes(url.protocol)) return { valid: false, reason: 'Invalid protocol' };
      if (this.isPrivate(url.hostname)) return { valid: false, reason: 'Private host blocked' };
      try {
        for (const a of await dns.resolve4(url.hostname)) {
          if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv4' };
        }
      } catch (e) {}
      try {
        for (const a of await dns.resolve6(url.hostname)) {
          if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv6' };
        }
      } catch (e) {}
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: e.message || 'Invalid URL' };
    }
  }
}

function resolveUrl(base, rel) {
  try {
    if (!rel) return null;
    let value = String(rel).trim();
    value = value
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#x2f;|&#47;/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u003d/gi, '=')
      .replace(/\\u003a/gi, ':')
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/');
    try {
      if (/%[0-9a-f]{2}/i.test(value)) value = decodeURIComponent(value);
    } catch (e) {}
    if (/^(https?:|blob:|data:)/i.test(value)) return value;
    if (value.startsWith('//')) {
      const scheme = /^http:/i.test(String(base || '')) ? 'http:' : 'https:';
      return scheme + value;
    }
    const origin = String(base || '').trim();
    if (!origin) return null;
    return new URL(value, origin).href;
  } catch (e) {
    return null;
  }
}

function extractUrlCandidates(value = '', base = '') {
  if (!value || typeof value !== 'string') return [];
  const decoded = value
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/');
  const found = new Set();
  const add = (candidate) => {
    const cleaned = String(candidate || '').replace(/[\\"'<>`),;]+$/g, '').trim();
    if (!cleaned || /^(javascript:|mailto:|#)/i.test(cleaned)) return;
    const absolute = resolveUrl(base, cleaned);
    if (absolute && /^https?:/i.test(absolute)) found.add(absolute);
  };
  const re = /(?:https?:)?\/\/[^\s"'<>`\\]+/gi;
  let match;
  while ((match = re.exec(decoded)) !== null) add(match[0]);
  return [...found];
}

function isRejectedMediaUrl(url = '') {
  return /doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|facebook\.com\/tr|hotjar|clarity\.ms|scorecardresearch|analytics|tracking|tracker|pixel|beacon|adservice|adsystem|advert|banner|\/ads?(?:\/|\?|$)/i.test(
    String(url || '')
  );
}

/** Placeholder / test / ad autoplay clips that must never count as success */
function isJunkMediaUrl(url = '') {
  const u = String(url || '').toLowerCase();
  if (!u) return true;
  if (isRejectedMediaUrl(u)) return true;
  return /canautoplayinline|autoplay.?test|blank\.mp4|dummy\.mp4|sample\.mp4|test\.mp4|placeholder|1x1\.|pixel\.|spacer\.|transparent\.|ads?[-_]?video|preroll|midroll|postroll|ima_sdk|vast\.|googlevideo\.com\/videoplayback\?.*ad|mmcdn\.com\/videos\/can|chaturbate\.com|stripchat|livejasmin/i.test(
    u
  );
}

function canonicalMediaKey(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const normalized = raw.startsWith('//') ? 'https:' + raw : raw;
    const u = new URLParser(normalized);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.href;
  } catch (e) {
    return raw.split('#')[0].replace(/\/$/, '');
  }
}

function inferQuality(url = '', width = 0, height = 0) {
  const h = Number(height || 0);
  const text = String(url || '').toLowerCase();
  const m = text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)p?(?:[^0-9]|$)/);
  const value = h || (m ? Number(m[1]) : 0);
  if (value >= 2160) return '2160p';
  if (value >= 1440) return '1440p';
  if (value >= 1080) return '1080p';
  if (value >= 720) return '720p';
  if (value >= 576) return '576p';
  if (value >= 480) return '480p';
  if (value >= 360) return '360p';
  if (value >= 240) return '240p';
  return null;
}

function inferSubtitleLanguage(url = '', label = '', language = null) {
  if (language) return String(language).toLowerCase();
  const text = `${url} ${label}`.toLowerCase();
  const m = text.match(/[._-](ar|ara|en|eng|fr|fra|de|ger|es|spa|it|ita|nl|nld|pl|pol)(?:[._-]|\?|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function isMediaSegment(url = '') {
  return /\.(m4s|ts)(?:\?|#|$)/i.test(String(url || '')) || /\/(?:segment|chunk|fragments?)(?:\/|\?|$)/i.test(String(url || ''));
}

function looksLikeMedia(url = '', ct = '') {
  const u = String(url || '').toLowerCase();
  const c = String(ct || '').toLowerCase();
  if (isRejectedMediaUrl(u) || isJunkMediaUrl(u)) return false;
  if (/\.(m3u8|mp4|webm|mpd|m4v|mov|mkv)(\?|#|$)/i.test(u)) return true;
  if (/\.(m4s|ts)(\?|#|$)/i.test(u)) return true;
  if (/\/hls\/|\/dash\/|\/manifest(?:\/|\?|$)|playlist|master\.json|videoplayback/i.test(u)) return true;
  if (c.includes('mpegurl') || c.includes('dash+xml') || c.includes('vnd.apple') || c.startsWith('video/')) return true;
  return false;
}

function classifyMedia(url = '', ct = '') {
  const u = String(url || '').toLowerCase();
  const c = String(ct || '').toLowerCase();
  if (u.includes('.m3u8') || c.includes('mpegurl') || c.includes('vnd.apple')) return 'm3u8';
  if (u.includes('.mpd') || c.includes('dash+xml')) return 'mpd';
  if (isMediaSegment(u)) return 'segment';
  if (u.includes('.webm') || c.includes('webm')) return 'webm';
  if (u.includes('.mp4') || c.includes('mp4') || c.startsWith('video/')) return 'mp4';
  if (/\.(m4v|mov|mkv)(?:\?|#|$)/i.test(u)) return 'other';
  if (looksLikeMedia(url, ct)) return 'm3u8';
  return null;
}

function looksLikeSubtitle(url = '', ct = '') {
  const u = String(url || '').toLowerCase();
  const c = String(ct || '').toLowerCase();
  if (/\.(vtt|srt|ass|ssa)(\?|#|$)/i.test(u)) return true;
  if (c.includes('text/vtt') || c.includes('application/x-subrip')) return true;
  if (/subtitle|captions|\.vtt|\/subs?\//i.test(u)) return true;
  return false;
}

function extractLinkMeta(url, referer = null) {
  const meta = { expiresAt: null, ttlSeconds: null, referer: referer || null, likelySigned: false };
  try {
    const parsed = new URLParser(url);
    const keys = ['expires', 'expire', 'expiry', 'exp', 'end', 'expires_at', 'valid_until', 'token_exp', 'e', 'st'];
    let raw = null;
    for (const key of keys) {
      raw = parsed.searchParams.get(key);
      if (raw) break;
    }
    if (raw) {
      const numeric = Number(raw);
      const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(raw);
      if (!Number.isNaN(date.getTime())) {
        meta.expiresAt = date.toISOString();
        meta.ttlSeconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
        meta.likelySigned = true;
      }
    }
    if (/[?&](signature|sig|token|hdnts|auth|hash|hmac|key|e|st)=/i.test(url)) meta.likelySigned = true;
    if (!meta.ttlSeconds && /[?&](hdnts|token|auth)=/i.test(url)) meta.likelySigned = true;
  } catch (e) {}
  return meta;
}

function rankScore(url, extra = {}) {
  const u = String(url || '').toLowerCase();
  let s = 0;
  // Prefer adaptive streams over random progressive files
  if (u.includes('.m3u8')) s += 70;
  if (u.includes('.mpd')) s += 62;
  if (u.includes('.mp4')) s += 40;
  if (/master|playlist|index\.m3u8/i.test(u)) s += 12;
  if (/2160|4k/.test(u)) s += 30;
  if (/1080|1920/.test(u)) s += 22;
  if (/720/.test(u)) s += 14;
  if (/480|360/.test(u)) s += 4;
  if (extra.bandwidth) s += Math.min(12, Math.floor(Number(extra.bandwidth) / 2_000_000));
  if (extra.validated) s += 20;
  if (extra.contentLength && extra.contentLength > 1_000_000) s += 10;
  if (extra.drmSuspected) s -= 60;
  if (isJunkMediaUrl(u)) s -= 200;
  if (/preview|trailer|thumb|poster|sample/.test(u)) s -= 25;
  if (isMediaSegment(u)) s -= 40;
  if (u.startsWith('blob:')) s -= 50;
  return s;
}

function pickByQuality(variants, quality = 'auto') {
  if (!variants?.length) return null;
  const scoreOf = (v) =>
    rankScore(v.url, {
      bandwidth: v.bandwidth,
      validated: !!v.validation?.valid,
      drmSuspected: !!v.drmSuspected || v.validation?.drmSuspected
    });
  if (!quality || quality === 'auto') {
    return [...variants].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
  }
  const q = String(quality).toLowerCase();
  const matched = variants.filter(
    (v) => String(v.quality || '').toLowerCase().includes(q) || String(v.url || '').toLowerCase().includes(q)
  );
  if (matched.length) return [...matched].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
  return [...variants].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
}

function titleSimilarity(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(' ').filter((w) => w.length > 1));
  const wb = new Set(nb.split(' ').filter((w) => w.length > 1));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

const httpClient = axios.create({
  timeout: 12000,
  maxRedirects: 4,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json, text/html, */*'
  },
  validateStatus: (s) => s >= 200 && s < 400
});

class DASHParser {
  static attr(tag, name) {
    const re = new RegExp('\\b' + name + '\\s*=\\s*[\"\\\']([^\"\\\']*)[\"\\\']', 'i');
    return re.exec(tag)?.[1] || null;
  }

  static quality(height, width) {
    const h = Number(height || 0);
    const w = Number(width || 0);
    if (h >= 2160 || w >= 3840) return '2160p';
    if (h >= 1440 || w >= 2560) return '1440p';
    if (h >= 1080 || w >= 1920) return '1080p';
    if (h >= 720 || w >= 1280) return '720p';
    if (h >= 480 || w >= 854) return '480p';
    return h ? h + 'p' : 'dash';
  }

  static parse(mpd, baseUrl) {
    const variants = [];
    const subtitles = [];
    const baseFromMpd = resolveUrl(baseUrl, /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(mpd)?.[1] || '') || baseUrl;
    const reps = [...String(mpd || '').matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)];
    for (const match of reps) {
      const attrs = match[1] || '';
      const body = match[2] || '';
      const mime = (DASHParser.attr(attrs, 'mimeType') || '').toLowerCase();
      const contentType = (DASHParser.attr(attrs, 'contentType') || '').toLowerCase();
      if (contentType === 'text' || mime.includes('text') || mime.includes('application/ttml')) continue;
      const id = DASHParser.attr(attrs, 'id') || null;
      const bandwidth = Number(DASHParser.attr(attrs, 'bandwidth') || 0);
      const width = Number(DASHParser.attr(attrs, 'width') || 0);
      const height = Number(DASHParser.attr(attrs, 'height') || 0);
      const inheritedBase = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(body)?.[1] || baseFromMpd;
      const repBase = resolveUrl(baseFromMpd, inheritedBase) || baseFromMpd;
      if (!repBase || !/^https?:/i.test(repBase)) continue;
      variants.push({ url: repBase, id, bandwidth, resolution: width && height ? width + 'x' + height : null, quality: DASHParser.quality(height, width), type: 'dash' });
    }
    for (const match of String(mpd || '').matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
      const attrs = match[1] || '';
      const body = match[2] || '';
      const mime = (DASHParser.attr(attrs, 'mimeType') || '').toLowerCase();
      const contentType = (DASHParser.attr(attrs, 'contentType') || '').toLowerCase();
      if (!(contentType === 'text' || mime.includes('text') || mime.includes('ttml') || mime.includes('vtt'))) continue;
      const lang = DASHParser.attr(attrs, 'lang');
      const label = DASHParser.attr(attrs, 'label') || lang || 'subtitle';
      for (const u of body.matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)) {
        const abs = resolveUrl(baseFromMpd, u[1]);
        if (abs) subtitles.push({ url: abs, language: lang || null, label, type: 'dash' });
      }
    }
    return { variants, subtitles };
  }

  static async enrich(mpdUrl, referer = null) {
    try {
      const text = await HLSParser.fetchText(mpdUrl, referer);
      if (!/<MPD[\s>]/i.test(text)) return { variants: [], subtitles: [] };
      const parsed = DASHParser.parse(text, mpdUrl);
      if (!parsed.variants.length) parsed.variants.push({ url: mpdUrl, quality: 'dash', bandwidth: 0, type: 'dash' });
      return parsed;
    } catch (e) {
      return { variants: [{ url: mpdUrl, quality: 'dash', bandwidth: 0, type: 'dash' }], subtitles: [] };
    }
  }
}

class HLSParser {
  static async fetchText(url, referer = null) {
    const res = await httpClient.get(url, {
      maxContentLength: 2_000_000,
      headers: { Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
      timeout: 8000
    });
    return String(res.data || '');
  }

  static parseAttributes(input = '') {
    const attrs = {};
    const re = /([A-Z0-9-]+)\s*=\s*("(?:[^"]|"")*"|'[^']*'|[^,]*)/gi;
    let m;
    while ((m = re.exec(String(input))) !== null) {
      attrs[m[1].toUpperCase()] = String(m[2] || '').trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    }
    return attrs;
  }

  static parseMaster(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = this.parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let nextIndex = i + 1;
      while (nextIndex < lines.length && (!lines[nextIndex].trim() || lines[nextIndex].trim().startsWith('#'))) nextIndex++;
      const next = (lines[nextIndex] || '').trim();
      if (!next) continue;
      const abs = resolveUrl(baseUrl, next);
      if (!abs) continue;
      const bandwidth = Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0);
      const resolution = attrs.RESOLUTION || null;
      const height = resolution && resolution.includes('x') ? Number(resolution.split('x')[1]) : 0;
      const width = resolution && resolution.includes('x') ? Number(resolution.split('x')[0]) : 0;
      let quality = attrs.NAME || (height ? (height >= 2160 ? '2160p' : height >= 1440 ? '1440p' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : height + 'p') : null);
      variants.push({ url: abs, bandwidth, averageBandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || 0), resolution, width, height, codecs: attrs.CODECS || null, frameRate: attrs['FRAME-RATE'] || null, audioGroup: attrs.AUDIO || null, subtitleGroup: attrs.SUBTITLES || null, quality: quality || 'unknown', type: 'hls' });
      i = nextIndex;
    }
    return variants;
  }

  static parseSubtitles(text, baseUrl) {
    const subs = [];
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/i.test(line)) continue;
      const attrs = this.parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const uri = attrs.URI;
      const abs = uri ? resolveUrl(baseUrl, uri) : null;
      if (abs) subs.push({ url: abs, language: attrs.LANGUAGE || null, label: attrs.NAME || attrs.LANGUAGE || 'subtitle', group: attrs['GROUP-ID'] || null, default: String(attrs.DEFAULT).toUpperCase() === 'YES', forced: String(attrs.FORCED).toUpperCase() === 'YES', autoselect: String(attrs.AUTOSELECT).toUpperCase() === 'YES', type: 'hls' });
    }
    for (const u of extractUrlCandidates(String(text || ''), baseUrl)) {
      if (/\.(vtt|srt|ass|ssa|ttml)(?:\?|#|$)/i.test(u) && !subs.some((x) => x.url === u)) subs.push({ url: u, language: null, label: 'subtitle', type: 'file' });
    }
    return subs;
  }

  static async enrich(m3u8Url, referer = null) {
    try {
      const text = await this.fetchText(m3u8Url, referer);
      if (!text.includes('#EXTM3U')) return { variants: [], subtitles: [] };
      if (/EXT-X-KEY:.*METHOD=(?!NONE)/i.test(text)) {
        return {
          variants: [{ url: m3u8Url, quality: 'encrypted', bandwidth: 0, type: 'hls', drmSuspected: true }],
          subtitles: this.parseSubtitles(text, m3u8Url)
        };
      }
      const subtitles = this.parseSubtitles(text, m3u8Url);
      if (text.includes('#EXT-X-STREAM-INF')) {
        return { variants: this.parseMaster(text, m3u8Url), subtitles };
      }
      return { variants: [{ url: m3u8Url, quality: 'media', bandwidth: 0, type: 'hls' }], subtitles };
    } catch (e) {
      return { variants: [], subtitles: [] };
    }
  }
}

const PAGE_HOOK_SCRIPT = `
(function(){
  if (window.__vdProHooks) return;
  window.__vdProHooks = true;
  window.__vdCaptured = [];
  window.__vdSignals = { mse: false, eme: false };
  function push(u, why){
    try {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('http') !== 0 && u.indexOf('//') !== 0 && u.indexOf('blob:') !== 0) return;
      if (u.indexOf('//') === 0) u = location.protocol + u;
      window.__vdCaptured.push({ url: u, why: why || 'hook', t: Date.now() });
    } catch(e){}
  }
  try {
    var ofetch = window.fetch;
    window.fetch = function(){
      try {
        var a = arguments[0];
        var u = typeof a === 'string' ? a : (a && a.url);
        if (u) push(String(u), 'fetch');
      } catch(e){}
      return ofetch.apply(this, arguments);
    };
  } catch(e){}
  try {
    var xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      try { if (url) push(String(url), 'xhr'); } catch(e){}
      return xo.apply(this, arguments);
    };
  } catch(e){}
  try {
    if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
      var add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function(){
        try { window.__vdSignals.mse = true; } catch(e){}
        return add.apply(this, arguments);
      };
    }
  } catch(e){}
  try {
    if (navigator.requestMediaKeySystemAccess) {
      var orig = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function(){
        try { window.__vdSignals.eme = true; } catch(e){}
        return orig.apply(null, arguments);
      };
    }
  } catch(e){}
})();
`;

class StealthGenerator {
  static script() {
    return `(function(){
Object.defineProperty(navigator,'webdriver',{get:function(){return false}});
try{delete navigator.__proto__.webdriver}catch(e){}
Object.defineProperty(navigator,'languages',{get:function(){return ['en-US','en','ar']}});
window.chrome=window.chrome||{runtime:{},app:{}};
})();`;
  }
}

class ProxyManager {
  constructor() {
    this.proxies = PROXIES.map((url, id) => ({
      url,
      id,
      health: { success: 0, failed: 0, consecutive: 0, available: true, checked: false, checking: false, lastCheckAt: null, lastError: null, latencyMs: null }
    }));
  }
  parse(url) {
    try {
      const u = new URL(url.includes('://') ? url : 'http://' + url);
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') } : undefined };
    } catch { return null; }
  }
  async checkOne(proxy) {
    if (!proxy || proxy.health.checking) return proxy?.health;
    const parsed = this.parse(proxy.url);
    proxy.health.checking = true;
    proxy.health.lastCheckAt = new Date().toISOString();
    const started = Date.now();
    try {
      if (!parsed) throw new Error('INVALID_PROXY_URL');
      const response = await axios.get('https://api.ipify.org?format=json', { proxy: parsed, timeout: 8000, validateStatus: () => true });
      if (response.status < 200 || response.status >= 400) throw new Error(`PROXY_HTTP_${response.status}`);
      proxy.health.checked = true; proxy.health.available = true; proxy.health.lastError = null; proxy.health.latencyMs = Date.now() - started; proxy.health.consecutive = 0;
    } catch (e) {
      proxy.health.checked = true; proxy.health.available = false; proxy.health.lastError = String(e.code || e.message || 'PROXY_CHECK_FAILED').slice(0, 160); proxy.health.latencyMs = Date.now() - started; proxy.health.consecutive++;
    } finally { proxy.health.checking = false; }
    return proxy.health;
  }
  async checkAll() { return Promise.all(this.proxies.map((p) => this.checkOne(p))); }
  getNext(exclude = null) {
    if (!this.proxies.length) return null;
    const ok = this.proxies.filter((p) => p.health.available && (!exclude || p.id !== exclude.id));
    if (!ok.length) return null;
    return ok[Math.floor(Math.random() * ok.length)];
  }
  success(p) {
    if (!p) return;
    p.health.success++;
    p.health.consecutive = 0;
    p.health.available = true;
  }
  fail(p) {
    if (!p) return;
    p.health.failed++;
    p.health.consecutive++;
    if (p.health.consecutive >= 5) p.health.available = false;
  }
  status() {
    return this.proxies.map((p) => {
      let safe = p.url;
      try {
        const u = new URL(p.url.includes('://') ? p.url : 'http://' + p.url);
        if (u.username || u.password) safe = u.protocol + '//' + u.hostname + (u.port ? ':' + u.port : '');
      } catch (e) {
        safe = '[redacted]';
      }
      return { url: safe, available: p.health.available, checked: p.health.checked, checking: p.health.checking, success: p.health.success, failed: p.health.failed, consecutive: p.health.consecutive, lastCheckAt: p.health.lastCheckAt, lastError: p.health.lastError, latencyMs: p.health.latencyMs };
    });
  }
}
const proxyManager = new ProxyManager();

class SessionManager {
  async load(userId) {
    if (!userId) return [];
    try {
      const c = await redis.get('session:' + userId);
      if (c) return JSON.parse(c).cookies || [];
    } catch (e) {}
    return [];
  }
  async save(userId, cookies) {
    if (!userId) return;
    try {
      await redis.setex('session:' + userId, 604800, JSON.stringify({ cookies }));
    } catch (e) {}
  }
}
const sessionManager = new SessionManager();

class BrowserContextPool {
  constructor(browser, size = 2) {
    this.browser = browser;
    this.size = size;
    this.available = [];
    this.inUse = new Map();
  }
  async create(proxy = null) {
    const opts = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      serviceWorkers: 'block',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' }
    };
    if (proxy?.url) opts.proxy = { server: proxy.url };
    const context = await this.browser.newContext(opts);
    const page = await context.newPage();
    await page.addInitScript(StealthGenerator.script());
    await page.addInitScript(PAGE_HOOK_SCRIPT);
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font') return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
    return { context, page, createdAt: Date.now(), usage: 0, proxy, pool: this };
  }
  async init() {
    for (let i = 0; i < this.size; i++) this.available.push(await this.create(null));
  }
  async get(proxy = null) {
    if (this.available.length) {
      const ctx = this.available.pop();
      if (proxy && ctx.proxy?.url !== proxy?.url) {
        await this.close(ctx);
        const fresh = await this.create(proxy);
        this.inUse.set(fresh, true);
        return fresh;
      }
      this.inUse.set(ctx, true);
      return ctx;
    }
    const fresh = await this.create(proxy);
    this.inUse.set(fresh, true);
    return fresh;
  }
  release(ctx) {
    if (!ctx) return;
    this.inUse.delete(ctx);
    if (ctx.context?.__vdClosed || Date.now() - ctx.createdAt > 30 * 60 * 1000 || ctx.usage > 20) {
      this.close(ctx);
      return;
    }
    ctx.usage++;
    this.available.push(ctx);
  }
  async close(ctx) {
    if (!ctx) return;
    try {
      if (ctx.context) ctx.context.__vdClosed = true;
      await ctx.page?.close?.().catch(() => {});
    } catch (e) {}
    try {
      await ctx.context?.close?.().catch(() => {});
    } catch (e) {}
  }
  async closeAll() {
    await Promise.all([...this.available, ...this.inUse.keys()].map((c) => this.close(c)));
    this.available = [];
    this.inUse.clear();
  }
}

class BrowserPool {
  constructor(n = 2) {
    this.n = Math.max(1, Math.min(4, Number(n) || 1));
    this.browsers = [];
    this.pools = [];
  }
  async init() {
    for (let i = 0; i < this.n; i++) {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--autoplay-policy=no-user-gesture-required',
          '--window-size=1366,768'
        ],
        timeout: 25000
      });
      this.browsers.push(browser);
      const pool = new BrowserContextPool(browser, BROWSER_CONTEXTS_PER_POOL);
      await pool.init();
      this.pools.push(pool);
    }
    logger.info({ browsers: this.n }, 'Browser pool ready');
  }
  async get(proxy = null) {
    if (!this.pools.length) throw new Error('No browser pools');
    return this.pools[Math.floor(Math.random() * this.pools.length)].get(proxy);
  }
  release(ctx) {
    if (ctx?.pool) ctx.pool.release(ctx);
  }
  async closeAll() {
    await Promise.all(this.pools.map((p) => p.closeAll()));
    await Promise.all(this.browsers.map((b) => b.close().catch(() => {})));
  }
}
let browserPool = null;

async function tryClickPlay(page) {
  const selectors = [
    'button[aria-label*="Play" i]',
    '[title*="Play" i]',
    '[data-testid*="play" i]',
    '.vjs-big-play-button',
    '.plyr__control--overlaid',
    '.jw-icon-display',
    '.jw-display-icon-container',
    'button.play',
    '[class*="play-button" i]',
    '[class*="playbtn" i]',
    '[class*="btn-play" i]',
    'div[class*="play"][role="button"]',
    'video'
  ];
  let clicked = false;
  for (const frame of page.frames().slice(0, 12)) {
    for (const sel of selectors) {
      try {
        const els = await frame.$$(sel);
        for (const el of els.slice(0, 3)) {
          await el.click({ timeout: 700 }).catch(() => {});
          clicked = true;
        }
      } catch (e) {}
    }
  }
  return clicked;
}

async function forceHtml5Play(page) {
  try {
    return await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('video').forEach((v) => {
        try {
          v.muted = true;
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
          n++;
        } catch (e) {}
      });
      return n;
    });
  } catch (e) {
    return 0;
  }
}

/** Generic: server / quality / watch / episode controls on multi-source pages */
async function tryClickPlayerTabs(page) {
  const tabSelectors = [
    '[class*="server" i] button',
    '[class*="servers" i] a',
    '[class*="servers" i] li',
    '[class*="servers" i] span',
    '[class*="quality" i] button',
    '[class*="source" i] a',
    '[class*="player" i] a[href*="http"]',
    'a[href*="server"]',
    'button[data-server]',
    'button[data-embed]',
    '[data-embed]',
    '[data-link]',
    '[data-url*="http"]',
    '.watching a',
    '.episode-server a',
    '#watch a',
    '#player-option a',
    '.player-options a',
    '.nav-pills a',
    '[role="tab"]'
  ];
  let n = 0;
  for (const frame of page.frames().slice(0, 8)) {
    for (const sel of tabSelectors) {
      try {
        const els = await frame.$$(sel);
        for (const el of els.slice(0, 5)) {
          try {
            const box = await el.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              await el.click({ timeout: 600 }).catch(() => {});
              n++;
              await sleep(350).catch(() => {});
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  }
  // Text-match generic watch/play labels (Latin + common Arabic UI words)
  try {
    n += await page.evaluate(() => {
      let c = 0;
      const re = /watch|play|server|source|load|stream|مشاهدة|تشغيل|سيرفر|الجودة|تحميل/i;
      const nodes = document.querySelectorAll('a, button, li, span, div[role="button"]');
      for (const el of nodes) {
        if (c >= 8) break;
        const t = (el.innerText || el.textContent || '').trim();
        if (t.length > 0 && t.length < 40 && re.test(t)) {
          try {
            el.click();
            c++;
          } catch (e) {}
        }
      }
      return c;
    });
  } catch (e) {}
  return n;
}

async function activateLazyIframes(page) {
  try {
    return await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('iframe').forEach((f) => {
        const ds = f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || f.getAttribute('data-url');
        if (ds && (!f.src || f.src === 'about:blank')) {
          try {
            f.src = ds;
            n++;
          } catch (e) {}
        }
      });
      return n;
    });
  } catch (e) {
    return 0;
  }
}

function mediaResponsePredicate(res) {
  try {
    const u = res.url();
    if (!u || isRejectedMediaUrl(u) || isJunkMediaUrl(u)) return false;
    const ct = String(res.headers?.()['content-type'] || '').toLowerCase();
    return /\.m3u8(?:\?|#|$)/i.test(u) || /\.mpd(?:\?|#|$)/i.test(u) || /\.mp4(?:\?|#|$)/i.test(u) || /\/(?:manifest|playlist|master|stream)(?:\/|\?|$)/i.test(u) || /mpegurl|dash\+xml|application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|^video\//i.test(ct) || (/json/i.test(ct) && /config|player|source|stream|media|video/i.test(u));
  } catch (e) {
    return false;
  }
}

/** Pull URLs from common player globals without site-specific hacks */
async function scrapePlayerConfigs(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const push = (u) => {
        if (typeof u === 'string' && u && out.indexOf(u) === -1) out.push(u);
      };
      const walk = (obj, depth) => {
        if (!obj || depth > 5) return;
        if (typeof obj === 'string') {
          if (/\.(m3u8|mp4|mpd|webm|vtt|srt)(\?|#|$)/i.test(obj) || /\/hls\/|\/manifest/i.test(obj)) push(obj);
          return;
        }
        if (Array.isArray(obj)) {
          obj.slice(0, 40).forEach((x) => walk(x, depth + 1));
          return;
        }
        if (typeof obj === 'object') {
          const keys = Object.keys(obj).slice(0, 60);
          for (const k of keys) {
            if (/file|src|source|sources|hls|dash|playlist|stream|url|video|fileUrl|playback/i.test(k)) {
              walk(obj[k], depth + 1);
            }
          }
        }
      };
      try {
        if (window.jwplayer) {
          const ids = document.querySelectorAll('[id]');
          ids.forEach((el) => {
            try {
              const p = window.jwplayer(el.id);
              if (p && p.getPlaylist) walk(p.getPlaylist(), 0);
              if (p && p.getConfig) walk(p.getConfig(), 0);
            } catch (e) {}
          });
        }
      } catch (e) {}
      try {
        if (window.videojs) {
          document.querySelectorAll('video, .video-js').forEach((el) => {
            try {
              const p = window.videojs.getPlayer ? window.videojs.getPlayer(el) : null;
              if (p && p.currentSource) walk(p.currentSource(), 0);
              if (p && p.currentSources) walk(p.currentSources(), 0);
            } catch (e) {}
          });
        }
      } catch (e) {}
      try {
        if (window.Clappr && window.Clappr.Player) walk(window.player, 0);
      } catch (e) {}
      try {
        [window.__INITIAL_STATE__, window.__NEXT_DATA__, window.playerConfig, window.config, window.videoConfig, window.player, window.video, window.__PLAYER_CONFIG__, window.__PLAYER_STATE__, window.__VIDEO_CONFIG__].forEach(
          (x) => walk(x, 0)
        );
      } catch (e) {}
      return out;
    });
  } catch (e) {
    return [];
  }
}

class ResultValidator {
  static inspect(url, status, contentType, body = '', contentLength = null, contentRange = '') {
    if (isJunkMediaUrl(url)) return { valid: false, reason: 'JUNK_OR_PLACEHOLDER', status, contentType };
    if (status < 200 || status >= 400) return { valid: false, reason: 'INVALID_STATUS', status, contentType };
    const isMp4 = /\.mp4(?:\?|#|$)/i.test(url);
    const binary = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
    const textPreview = binary.subarray(0, 16384).toString('utf8');
    const mp4Signature = binary.subarray(0, 16384).includes(Buffer.from('ftyp'));
    if (/\.m3u8(?:\?|#|$)/i.test(url) && !String(body || '').includes('#EXTM3U')) {
      return { valid: false, reason: 'INVALID_M3U8', status, contentType };
    }
    if (/\.mpd(?:\?|#|$)/i.test(url) && !/<MPD[\s>]/i.test(String(body || ''))) {
      return { valid: false, reason: 'INVALID_MPD', status, contentType };
    }
    if (isMp4 && (/text\/html|application\/json/i.test(String(contentType || '')) || /^\s*<(?:!doctype|html|body)\b/i.test(textPreview) || /^\s*[<{][\s\S]{0,200}/.test(textPreview) && !mp4Signature)) {
      return { valid: false, reason: 'HTML_NOT_MEDIA', status, contentType };
    }
    if (isMp4 && !(/^(?:video\/mp4|video\/)/i.test(String(contentType || '')) || mp4Signature || (/^application\/octet-stream/i.test(String(contentType || '')) && (mp4Signature || /bytes\s+\d+-\d+\//i.test(String(contentRange || '')))))) {
      return { valid: false, reason: 'MP4_SIGNATURE_OR_TYPE_MISSING', status, contentType };
    }
    if (/EXT-X-KEY:.*METHOD=(?!NONE)/i.test(String(body || ''))) {
      return { valid: false, reason: 'DRM_OR_ENCRYPTED_HLS', status, contentType, drmSuspected: true };
    }
    // Progressive MP4 under ~80KB is almost always a stub/ad clip
    const len = contentLength != null ? Number(contentLength) : null;
    if (/\.mp4(?:\?|#|$)/i.test(url) && Number.isFinite(len) && len > 0 && len < 80_000) {
      return { valid: false, reason: 'TOO_SMALL_MP4', status, contentType, contentLength: len };
    }
    return { valid: true, reason: null, status, contentType, contentLength: len };
  }

  static async validateWithPage(url, page, referer = null) {
    if (!page?.context || page.context().__vdClosed) return { valid: false, reason: 'NO_PAGE_CONTEXT' };
    try {
      const response = await page.context().request.get(url, {
        timeout: 7000,
        failOnStatusCode: false,
        maxRedirects: 4,
        headers: { Accept: 'video/mp4,application/vnd.apple.mpegurl,application/dash+xml,*/*', Range: 'bytes=0-16383', ...(referer ? { Referer: referer } : {}) }
      });
      const headers = response.headers() || {};
      const contentType = headers['content-type'] || '';
      const cl = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;
      const body = await response.body().catch(() => Buffer.alloc(0));
      return this.inspect(url, response.status(), contentType, body, cl, headers['content-range'] || '');
    } catch (e) {
      return { valid: false, reason: 'PAGE_VALIDATION_FAILED' };
    }
  }

  static async validate(url, referer = null) {
    if (!url) return { valid: false, reason: 'NO_URL' };
    if (isJunkMediaUrl(url)) return { valid: false, reason: 'JUNK_OR_PLACEHOLDER' };
    try {
      new URLParser(url);
    } catch (e) {
      return { valid: false, reason: 'INVALID_URL' };
    }
    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'video/mp4,application/vnd.apple.mpegurl,application/dash+xml,*/*',
        Range: 'bytes=0-16383'
      };
      if (referer) {
        headers.Referer = referer;
        try {
          headers.Origin = new URLParser(referer).origin;
        } catch (e) {}
      }
      const res = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 3,
        maxContentLength: 250000,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        headers
      });
      const clHeader = res.headers?.['content-length'] || res.headers?.['content-range'];
      let cl = null;
      if (clHeader) {
        const m = /\/(\d+)/.exec(String(clHeader)) || /^(\d+)$/.exec(String(clHeader));
        if (m) cl = parseInt(m[1], 10);
      }
      return this.inspect(url, res.status, res.headers?.['content-type'] || '', res.data || '', cl, res.headers?.['content-range'] || '');
    } catch (e) {
      return { valid: false, reason: 'VALIDATION_FAILED' };
    }
  }
}

class VideoExtractor {
  constructor() {
    this.name = 'vd-pro';
  }

  empty() {
    return {
      m3u8: new Set(),
      mp4: new Set(),
      webm: new Set(),
      mpd: new Set(),
      segment: new Set(),
      other: new Set(),
      subtitles: new Set()
    };
  }

  add(bags, url, ct = '') {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || isRejectedMediaUrl(url) || isJunkMediaUrl(url)) return;
    if (looksLikeSubtitle(url, ct)) {
      bags.subtitles.add(url);
      return;
    }
    const k = classifyMedia(url, ct);
    if (k) bags[k].add(url);
    else if (looksLikeMedia(url, ct)) bags.other.add(url);
  }

  toObj(bags, base) {
    const abs = (arr) =>
      [...new Set([...arr].map((u) => resolveUrl(base, u) || u).filter((u) => u && /^https?:/i.test(u)))];
    return {
      m3u8: abs(bags.m3u8),
      mp4: abs(bags.mp4),
      webm: abs(bags.webm),
      mpd: abs(bags.mpd),
      segment: abs(bags.segment),
      other: abs(bags.other),
      subtitles: abs(bags.subtitles)
    };
  }

  mineHtml(html, bags, base) {
    const $ = cheerio.load(html || '');
    $('video, source, track, [data-src], [data-video], [data-url], [data-stream], [data-file], [data-hls]').each(
      (_, el) => {
        for (const a of ['src', 'data-src', 'data-video', 'data-url', 'data-stream', 'data-file', 'data-hls']) {
          const v = $(el).attr(a);
          if (v) this.add(bags, resolveUrl(base, v) || v);
        }
        if ($(el).is('track')) {
          const v = $(el).attr('src');
          if (v) { const abs = resolveUrl(base, v) || v; bags.subtitles.add(abs); }
        }
      }
    );
    const rules = [
      [/(https?:\/\/[^"'\\s<>{}]+?\.m3u8[^"'\\s<>{}]*)/gi, 'm3u8'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mp4[^"'\\s<>{}]*)/gi, 'mp4'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mpd[^"'\\s<>{}]*)/gi, 'mpd'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.webm[^"'\\s<>{}]*)/gi, 'webm'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.(vtt|srt|ass|ssa|ttml)(?:\?|#|$)[^"'\\s<>{}]*)/gi, 'subtitles']
    ];
    for (const [re, key] of rules) {
      let m;
      while ((m = re.exec(html)) !== null) {
        if (key === 'subtitles') bags.subtitles.add(m[1]);
        else bags[key].add(m[1]);
      }
    }
    for (const candidate of extractUrlCandidates(html, base)) this.add(bags, candidate);
    const cfg =
      /"(?:file|src|source|sources|hls|dash|playlist|stream|videoUrl|mediaUrl|playbackUrl|file_url|stream_url)"\s*:\s*"([^"]+)"/gi;
    let cm;
    while ((cm = cfg.exec(html)) !== null) {
      const u = cm[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      this.add(bags, resolveUrl(base, u) || u);
    }
    // Base64 payloads that decode to URLs (common in obfuscated players)
    const b64re = /(?:atob\s*\(\s*["']|["'])([A-Za-z0-9+/=]{40,})["']/g;
    let bm;
    while ((bm = b64re.exec(html)) !== null) {
      try {
        const decoded = Buffer.from(bm[1], 'base64').toString('utf8');
        if (/https?:\/\//i.test(decoded) || /\.m3u8|\.mp4|\.mpd/i.test(decoded)) {
          for (const candidate of extractUrlCandidates(decoded, base)) this.add(bags, candidate);
        }
      } catch (e) {}
    }
  }

  async extract(pageUrl, page, userId, options = {}) {
    const quality = options.quality || 'auto';
    const deep = options.deep === true || options.deep === '1' || options.deep === 'true';
    const started = Date.now();
    const diagnostics = {
      framesVisited: 0,
      requestsObserved: 0,
      mediaRequests: 0,
      playClicked: false,
      strategies: [],
      captchaSuspected: false,
      drmSuspected: false,
      mseDetected: false,
      timedOut: false,
      softRetry: false,
      blobDetected: false,
      adaptiveDeep: false
    };

    const result = {
      success: false,
      primaryUrl: null,
      urls: { m3u8: [], mp4: [], webm: [], mpd: [], segment: [], other: [] },
      variants: [],
      subtitles: [],
      qualities: [],
      duration: 0,
      strategy: null,
      quality,
      validated: false,
      linkMeta: null,
      error: null,
      errorCode: null,
      diagnostics,
      source: this.name,
      pageTitle: null,
      completedCleanly: false
    };

    const bags = this.empty();
    if (looksLikeMedia(pageUrl)) this.add(bags, pageUrl);
    const mediaReferers = new Map();
    const mediaHeaders = new Map();
    const mediaFrames = new Map();
    const mediaRedirects = new Map();
    const frameLifecycle = new Set();
    let finished = false;

    const onRequest = (req) => {
      try {
        diagnostics.requestsObserved++;
        const u = req.url();
        const headers = req.headers();
        if (headers.referer && (looksLikeMedia(u) || looksLikeSubtitle(u))) mediaReferers.set(canonicalMediaKey(u), headers.referer);
        if (looksLikeMedia(u) || looksLikeSubtitle(u)) {
          const key = canonicalMediaKey(u);
          const frameUrl = (() => { try { return req.frame()?.url() || pageUrl; } catch (e) { return pageUrl; } })();
          mediaFrames.set(key, frameUrl);
          mediaHeaders.set(key, { referer: headers.referer || frameUrl || pageUrl, origin: headers.origin || null, cookie: headers.cookie || null, frameUrl });
        }
        if (looksLikeMedia(u) || looksLikeSubtitle(u)) {
          diagnostics.mediaRequests++;
          this.add(bags, u);
        }
      } catch (e) {}
    };

    const onResponse = async (response) => {
      try {
        const u = response.url();
        const reqUrl = response.request()?.url?.() || null;
        if (reqUrl && reqUrl !== u && (looksLikeMedia(reqUrl) || looksLikeSubtitle(reqUrl))) mediaRedirects.set(canonicalMediaKey(u), reqUrl);
        const ct = response.headers()['content-type'] || '';
        if (looksLikeMedia(u, ct) || looksLikeSubtitle(u, ct)) {
          diagnostics.mediaRequests++;
          this.add(bags, u, ct);
          return;
        }
        const lowerType = String(ct).toLowerCase();
        if (lowerType.includes('text/') || lowerType.includes('json') || lowerType.includes('octet-stream')) {
          const path = u.toLowerCase();
          if (/manifest|playlist|stream|media|video|source|player|config|\.json(?:\?|$)/i.test(path) || lowerType.includes('json')) {
            const body = await response.text().catch(() => '');
            if (/^\s*#EXTM3U/m.test(body) || /<MPD[\s>]/i.test(body)) this.add(bags, u, ct);
            if (/EXT-X-KEY:.*METHOD=(?!NONE)/i.test(body)) diagnostics.drmSuspected = true;
            if (lowerType.includes('json') && body.length <= 2_000_000) {
              const embedded = extractUrlCandidates(body, u);
              for (const candidate of embedded) {
                if (/^blob:/i.test(candidate)) diagnostics.blobDetected = true;
                else this.add(bags, candidate);
              }
              if (embedded.length) diagnostics.strategies.push('json-media-config');
            }
          }
        }
      } catch (e) {}
    };

    const childPages = new Set();
    const onContextPage = (child) => {
      childPages.add(child);
      child.on('request', onRequest);
      child.on('response', onResponse);
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    const onFrameAttached = (frame) => { frameLifecycle.add(frame); diagnostics.framesAttached = (diagnostics.framesAttached || 0) + 1; };
    const onFrameNavigated = (frame) => { frameLifecycle.add(frame); diagnostics.framesNavigated = (diagnostics.framesNavigated || 0) + 1; };
    page.on('frameattached', onFrameAttached);
    page.on('framenavigated', onFrameNavigated);
    page.context().on('page', onContextPage);

    const harvestDomAndHooks = async (label) => {
      try { await sleep(deep ? 350 : 150); } catch (e) {}
      try {
        this.mineHtml(await page.content(), bags, pageUrl);
        diagnostics.strategies.push(label + '-dom');
      } catch (e) {}
      try {
        const fromPlayers = await scrapePlayerConfigs(page);
        fromPlayers.forEach((u) => this.add(bags, u));
        if (fromPlayers.length) diagnostics.strategies.push(label + '-player-config');
      } catch (e) {}
      try {
        const mediaUrls = await page.evaluate(() => {
          const out = [];
          const nodes = [...document.querySelectorAll('video, audio, source, track, iframe, [data-src], [data-url], [data-file], [data-hls], [data-mp4], [data-m3u8]')];
          const walk = (root) => {
            if (!root || !root.querySelectorAll) return;
            root.querySelectorAll('video, audio, source, track, iframe, [data-src], [data-url], [data-file], [data-hls], [data-mp4], [data-m3u8]').forEach((x) => nodes.push(x));
            root.querySelectorAll('*').forEach((x) => { if (x.shadowRoot) walk(x.shadowRoot); });
          };
          document.querySelectorAll('*').forEach((x) => { if (x.shadowRoot) walk(x.shadowRoot); });
          nodes.forEach((v) => {
            if (v.currentSrc) out.push(v.currentSrc);
            if (v.src) out.push(v.src);
            if (v.getAttribute) ['src','data-src','data-url','data-file','data-hls','data-mp4','data-m3u8'].forEach((a) => { const value = v.getAttribute(a); if (value) out.push(value); });
          });
          try {
            performance.getEntriesByType('resource').forEach((entry) => out.push(entry.name));
          } catch (e) {}
          (window.__vdCaptured || []).forEach((x) => out.push(x.url));
          return out;
        });
        mediaUrls.forEach((u) => {
          if (/^blob:/i.test(String(u || ''))) diagnostics.blobDetected = true;
          else this.add(bags, u);
        });
        const signals = await page.evaluate(() => ({
          mse: !!(window.__vdSignals && window.__vdSignals.mse),
          eme: !!(window.__vdSignals && window.__vdSignals.eme)
        }));
        diagnostics.mseDetected = diagnostics.mseDetected || !!signals.mse;
        if (signals.eme) diagnostics.drmSuspected = true;
        diagnostics.strategies.push(label + '-hooks');
      } catch (e) {}
      try {
        const frames = page.frames().slice(0, deep ? 14 : 8);
        diagnostics.framesVisited = Math.max(diagnostics.framesVisited || 0, page.frames().length);
        for (const frame of frames) {
          try {
            this.mineHtml(await frame.content(), bags, frame.url() || pageUrl);
            const fu = await frame.evaluate(() => {
              const out = [];
              document.querySelectorAll('video, audio, source, iframe, track').forEach((v) => {
                if (v.currentSrc) out.push(v.currentSrc);
                if (v.src) out.push(v.src);
                if (v.getAttribute) {
                  ['data-src', 'data-url', 'data-file', 'data-hls', 'data-lazy-src'].forEach((a) => {
                    const val = v.getAttribute(a);
                    if (val) out.push(val);
                  });
                }
              });
              (window.__vdCaptured || []).forEach((x) => out.push(x.url));
              return out;
            });
            fu.forEach((u) => this.add(bags, u));
          } catch (e) {}
        }
        diagnostics.dynamicFrames = Math.max(diagnostics.dynamicFrames || 0, frameLifecycle.size, page.frames().length - 1);
        diagnostics.strategies.push(label + '-frames');
      } catch (e) {}
    };

    const hasPlayable = () => {
      const mid = this.toObj(bags, pageUrl);
      return !!(mid.m3u8.length || mid.mp4.length || mid.mpd.length || mid.webm.length);
    };

    const work = async () => {
      const cookies = await sessionManager.load(userId);
      if (cookies?.length) {
        try {
          await page.context().addCookies(cookies);
        } catch (e) {}
      }

      // Parallel waiter: capture first real media response during whole interaction window
      const mediaWait = page
        .waitForResponse(mediaResponsePredicate, { timeout: Math.min(HARD_EXTRACT_MS - 5000, deep ? 90000 : 55000) })
        .then((res) => {
          try {
            this.add(bags, res.url(), res.headers()['content-type'] || '');
            diagnostics.mediaWaitHit = true;
          } catch (e) {}
        })
        .catch(() => {});

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } catch (e) {
        diagnostics.navWarning = e.message;
      }

      try {
        result.pageTitle = await page.title();
        const snippet = await page.evaluate(() =>
          document.body && document.body.innerText ? document.body.innerText.slice(0, 1800) : ''
        );
        const blob = (result.pageTitle || '') + ' ' + snippet;
        if (/captcha|cloudflare|verify you are human|attention required|cf-challenge/i.test(blob)) {
          diagnostics.captchaSuspected = true;
        }
        if (/widevine|fairplay|playready|drm|encrypted media/i.test(blob)) {
          diagnostics.drmSuspected = true;
        }
      } catch (e) {}

      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(6000, NAV_TIMEOUT_MS) }).catch(() => {});
        await sleep(deep ? 1200 : 700);
        await page.evaluate(() => {
          window.scrollBy(0, 320);
          window.scrollBy(0, 320);
        });
      } catch (e) {}

      diagnostics.lazyIframes = await activateLazyIframes(page);
      await sleep(deep ? 800 : 400);

      // Interaction round 1
      diagnostics.playClicked = await tryClickPlay(page);
      diagnostics.html5Play = await forceHtml5Play(page);
      diagnostics.tabsClicked = await tryClickPlayerTabs(page);
      if (diagnostics.tabsClicked) {
        await tryClickPlay(page);
        await forceHtml5Play(page);
      }
      await sleep(deep ? 4200 : 2200);
      diagnostics.strategies.push('network');

      await harvestDomAndHooks('r1');

      // Interaction round 2 if nothing playable yet
      if (!hasPlayable()) {
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        diagnostics.tabsClicked = (diagnostics.tabsClicked || 0) + (await tryClickPlayerTabs(page));
        await forceHtml5Play(page);
        await sleep(deep ? 6500 : 3200);
        await harvestDomAndHooks('r2');
      }

      // Adaptive deep pass: delayed players may expose media only after a second interaction.
      if (!deep && diagnostics.mediaRequests > 0 && !hasPlayable()) {
        diagnostics.adaptiveDeep = true;
        await activateLazyIframes(page);
        diagnostics.tabsClicked = (diagnostics.tabsClicked || 0) + (await tryClickPlayerTabs(page));
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        await forceHtml5Play(page);
        await sleep(3000);
        await harvestDomAndHooks('adaptive-deep');
      }

      // Embed / iframe probe
      if (!hasPlayable()) {
        try {
          const embedded = await this.discoverEmbeddedCandidates(page, pageUrl, deep);
          if (embedded.length) {
            diagnostics.embeddedCandidates = embedded.length;
            for (const candidate of embedded) this.add(bags, candidate);
            diagnostics.strategies.push('embedded-candidates');
            await this.probeEmbeddedCandidates(page, embedded, bags, diagnostics, deep);
          }
        } catch (e) {
          diagnostics.embeddedWarning = e.message;
        }
      }

      // Deep final pass: activate newly-created iframes and repeat player controls.
      if (deep && !hasPlayable()) {
        await activateLazyIframes(page);
        diagnostics.tabsClicked = (diagnostics.tabsClicked || 0) + (await tryClickPlayerTabs(page));
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        await forceHtml5Play(page);
        await sleep(3000);
        await harvestDomAndHooks('deep');
        diagnostics.strategies.push('deep-pass');
      }

      // Allow late media requests to settle, without exceeding the hard extraction limit.
      if (!hasPlayable()) {
        await Promise.race([mediaWait, sleep(deep ? MEDIA_IDLE_WAIT_MS : Math.min(MEDIA_IDLE_WAIT_MS, 5000))]);
      } else {
        await Promise.race([mediaWait, sleep(Math.min(MEDIA_IDLE_WAIT_MS, 1500))]);
      }
    };

    try {
      await withTimeout(work(), HARD_EXTRACT_MS, 'EXTRACTION_TIMEOUT');
      finished = true;
    } catch (error) {
      if (error.code === 'EXTRACTION_TIMEOUT' || error.message === 'EXTRACTION_TIMEOUT') {
        diagnostics.timedOut = true;
        result.errorCode = 'EXTRACTION_TIMEOUT';
        result.error = 'Extraction exceeded time limit';
      } else {
        result.errorCode = 'EXTRACTION_ERROR';
        result.error = error.message;
      }
    } finally {
      try {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('frameattached', onFrameAttached);
        page.off('framenavigated', onFrameNavigated);
        page.context().off('page', onContextPage);
        for (const child of childPages) {
          child.off('request', onRequest);
          child.off('response', onResponse);
          await child.close().catch(() => {});
        }
        if (diagnostics.timedOut) {
          try {
            page.context().__vdClosed = true;
            await page.context().close();
          } catch (e) {}
        }
      } catch (e) {}
    }

    result.urls = this.toObj(bags, pageUrl);

    const variants = [];
    const subtitles = [];
    const hlsResults = await Promise.all(
      result.urls.m3u8.slice(0, 32).map(async (m) => {
        try {
          return await withTimeout(HLSParser.enrich(m, mediaReferers.get(canonicalMediaKey(m)) || pageUrl), 8000, 'HLS_TIMEOUT');
        } catch (e) {
          return { variants: [{ url: m, quality: 'unknown', bandwidth: 0, type: 'hls' }], subtitles: [] };
        }
      })
    );
    for (const en of hlsResults) {
      for (const v of en.variants || []) {
        if (v.drmSuspected) diagnostics.drmSuspected = true;
        variants.push(v);
      }
      subtitles.push(...(en.subtitles || []));
    }
    const dashResults = await Promise.all(
      result.urls.mpd.slice(0, 24).map(async (m) => {
        try {
          return await withTimeout(DASHParser.enrich(m, mediaReferers.get(canonicalMediaKey(m)) || pageUrl), 8000, 'DASH_TIMEOUT');
        } catch (e) {
          return { variants: [{ url: m, quality: 'dash', bandwidth: 0, type: 'dash' }], subtitles: [] };
        }
      })
    );
    for (const en of dashResults) {
      variants.push(...(en.variants || []));
      subtitles.push(...(en.subtitles || []));
    }
    for (const m of result.urls.mp4) variants.push({ url: m, quality: 'mp4', bandwidth: 0, type: 'mp4' });
    for (const m of result.urls.webm) variants.push({ url: m, quality: 'webm', bandwidth: 0, type: 'webm' });
    for (const m of result.urls.other) variants.push({ url: m, quality: 'other', bandwidth: 0, type: 'other' });
    for (const s of result.urls.subtitles) {
      subtitles.push({ url: s, language: null, label: 'subtitle', type: 'file' });
    }

    let uniqueVariants = [
      ...new Map(
        variants
          .filter(
            (v) =>
              v?.url &&
              !isRejectedMediaUrl(v.url) &&
              !isJunkMediaUrl(v.url) &&
              !isMediaSegment(v.url)
          ).map((v) => {
            v.quality = v.quality && v.quality !== 'media' && v.quality !== 'unknown' ? v.quality : (inferQuality(v.url, v.width, v.height) || v.quality || 'unknown');
            return [canonicalMediaKey(v.url), v];
          })
      ).values()
    ];

    const contextAlive = !!(page?.context && !page.context().__vdClosed);
    const validationResults = await Promise.all(
      uniqueVariants.slice(0, 24).map(async (v) => {
        const referer = mediaReferers.get(canonicalMediaKey(v.url)) || pageUrl;
        let check = { valid: false, reason: 'SKIPPED' };
        if (contextAlive) check = await ResultValidator.validateWithPage(v.url, page, referer);
        if (!check.valid) check = await ResultValidator.validate(v.url, referer);
        return { variant: v, check, referer };
      })
    );

    const anyValid = validationResults.some((x) => x.check.valid);
    const allowSoftRetry =
      !anyValid &&
      uniqueVariants.length &&
      !diagnostics.timedOut &&
      contextAlive &&
      !diagnostics.captchaSuspected &&
      !diagnostics.drmSuspected;
    if (allowSoftRetry) {
      diagnostics.softRetry = true;
      try {
        await sleep(1500);
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        await sleep(1200);
      } catch (e) {}
      for (let i = 0; i < validationResults.length; i++) {
        if (validationResults[i].check.valid) continue;
        let again = await ResultValidator.validateWithPage(
          validationResults[i].variant.url,
          page,
          validationResults[i].referer
        );
        if (!again.valid) {
          again = await ResultValidator.validate(
            validationResults[i].variant.url,
            validationResults[i].referer
          );
        }
        if (again.valid) validationResults[i].check = again;
      }
    }

    for (const x of validationResults) {
      x.variant.validation = x.check;
      x.variant.referer = x.referer;
      x.variant.requestContext = mediaHeaders.get(canonicalMediaKey(x.variant.url)) || { referer: mediaReferers.get(canonicalMediaKey(x.variant.url)) || pageUrl, frameUrl: mediaFrames.get(canonicalMediaKey(x.variant.url)) || pageUrl };
      x.variant.redirectedFrom = mediaRedirects.get(canonicalMediaKey(x.variant.url)) || null;
      if (x.check.drmSuspected) diagnostics.drmSuspected = true;
    }

    uniqueVariants = uniqueVariants.sort(
      (a, b) =>
        Number(b.validation?.valid) - Number(a.validation?.valid) ||
        rankScore(b.url, {
          bandwidth: b.bandwidth,
          validated: !!b.validation?.valid,
          drmSuspected: !!b.drmSuspected
        }) -
          rankScore(a.url, {
            bandwidth: a.bandwidth,
            validated: !!a.validation?.valid,
            drmSuspected: !!a.drmSuspected
          })
    );
    result.variants = uniqueVariants.slice(0, 40);
    result.subtitles = [...new Map(subtitles.filter((s) => s?.url).map((s) => { s.language = inferSubtitleLanguage(s.url, s.label, s.language); return [canonicalMediaKey(s.url), s]; })).values()].slice(0, 80);
    result.qualities = [...new Set(result.variants.map((v) => v.quality).filter(Boolean))];

    const validatedVariants = result.variants.filter((v) => v.validation?.valid);
    const picked = pickByQuality(validatedVariants.length ? validatedVariants : result.variants, quality);
    diagnostics.mediaCandidates = uniqueVariants.length;
    diagnostics.validatedCandidates = validatedVariants.length;
    diagnostics.mediaSignal = diagnostics.mediaRequests === 0
      ? 'no-media-requests'
      : picked && picked.validation?.valid
        ? 'media-request-validated'
        : 'media-requests-without-accepted-primary';

    if (picked && picked.url && picked.validation?.valid) {
      result.primaryUrl = picked.url;
      result.success = true;
      result.strategy = diagnostics.strategies.join('+') || 'partial';
      result.error = null;
      result.errorCode = null;
      result.linkMeta = extractLinkMeta(result.primaryUrl, picked.referer || pageUrl);
      result.validated = true;
    } else if (picked && picked.url) {
      result.primaryUrl = picked.url;
      result.success = false;
      result.linkMeta = extractLinkMeta(result.primaryUrl, picked.referer || pageUrl);
      result.validated = false;
      result.validationReason = picked.validation?.reason || 'UNVALIDATED';
      if (diagnostics.drmSuspected || picked.validation?.reason === 'DRM_OR_ENCRYPTED_HLS') {
        result.errorCode = 'DRM_PROTECTED';
        result.error = 'Encrypted/DRM media detected; Widevine/FairPlay cannot be decrypted';
      } else if (result.linkMeta?.likelySigned && (result.linkMeta.ttlSeconds === 0 || result.linkMeta.ttlSeconds < 30)) {
        result.errorCode = 'TOKEN_EXPIRED_OR_SHORT_LIVED';
        result.error = 'Signed media URL appears expired or extremely short-lived';
      } else {
        result.errorCode = 'STREAM_FOUND_BUT_UNPLAYABLE';
        result.error = 'Candidates found but none passed playback validation';
      }
    } else if (!result.errorCode) {
      if (diagnostics.captchaSuspected) {
        result.errorCode = 'BOT_PROTECTION_SUSPECTED';
        result.error = 'Possible CAPTCHA/bot protection; interactive challenges are not solved automatically';
      } else if (diagnostics.drmSuspected) {
        result.errorCode = 'DRM_PROTECTED';
        result.error = 'Page appears to use DRM/encrypted media';
      } else if (diagnostics.mseDetected) {
        result.errorCode = 'CLOSED_PLAYER_OR_BLOB_ONLY';
        result.error = 'Media pipeline detected (MSE) but no public stream URL was exposed';
      } else {
        result.errorCode = 'NO_STREAM_FOUND';
        result.error = 'No video streams found';
      }
    }

    try {
      if (page.context && !page.context.__vdClosed) {
        const c = await page.context().cookies();
        if (c.length) await sessionManager.save(userId, c);
      }
    } catch (e) {}

    result.duration = (Date.now() - started) / 1000;
    result.diagnostics = diagnostics;
    result.completedCleanly = finished;
    return result;
  }

  async discoverEmbeddedCandidates(page, baseUrl, deep = false) {
    const base = new URLParser(baseUrl);
    const raw = await page.evaluate(() => {
      const values = [];
      const add = (value) => {
        if (typeof value === 'string' && value.trim()) values.push(value.trim());
      };
      document.querySelectorAll('iframe, embed, object, video, audio, source, a, [data-src], [data-url], [data-embed], [data-player], [data-iframe]').forEach((el) => {
        ['src', 'href', 'data-src', 'data-url', 'data-play', 'data-embed', 'data-player', 'data-iframe'].forEach((key) => add(el.getAttribute(key)));
      });
      document.querySelectorAll('script').forEach((s) => add(s.textContent || ''));
      return values;
    });
    const out = new Set();
    for (const value of raw) {
      if (!value) continue;
      const matches = String(value).replace(/\\\//g, '/').match(/(?:https?:)?\/\/[^\s"'<>`\\]+/gi) || [];
      for (const match of matches) {
        try {
          const u = new URLParser(match.replace(/[),;]+$/, ''), base.href);
          if (!['http:', 'https:'].includes(u.protocol)) continue;
          if (u.href === base.href) continue;
          const path = (u.pathname + u.search).toLowerCase();
          const likelyPlayer = /iframe|embed|player|play|watch|video|stream|m3u8|mp4|mpd/.test(path);
          if (u.hostname !== base.hostname || likelyPlayer) out.add(u.href);
        } catch (e) {}
      }
    }
    return [...out].slice(0, deep ? 12 : 6);
  }

  async probeEmbeddedCandidates(page, candidates, bags, diagnostics, deep = false) {
    const context = page.context();
    for (const candidate of candidates.slice(0, deep ? 8 : 4)) {
      let child = null;
      try {
        child = await context.newPage();
        child.on('request', (req) => {
          try {
            if (looksLikeMedia(req.url())) this.add(bags, req.url());
          } catch (e) {}
        });
        child.on('response', (res) => {
          try {
            const u = res.url();
            const ct = res.headers()['content-type'] || '';
            if (looksLikeMedia(u, ct)) this.add(bags, u, ct);
          } catch (e) {}
        });
        const waitMedia = child
          .waitForResponse(mediaResponsePredicate, { timeout: deep ? 12000 : 8000 })
          .then((res) => {
            try {
              this.add(bags, res.url(), res.headers()['content-type'] || '');
            } catch (e) {}
          })
          .catch(() => {});
        await child.goto(candidate, { waitUntil: 'domcontentloaded', timeout: Math.min(NAV_TIMEOUT_MS, 20000) });
        await activateLazyIframes(child);
        await tryClickPlay(child);
        await forceHtml5Play(child);
        await sleep(deep ? 2500 : 1400);
        this.mineHtml(await child.content(), bags, candidate);
        const media = await child.evaluate(() => {
          const out = [];
          document.querySelectorAll('video, audio, source').forEach((el) => {
            if (el.currentSrc) out.push(el.currentSrc);
            if (el.src) out.push(el.src);
          });
          (window.__vdCaptured || []).forEach((x) => out.push(x.url));
          return out;
        });
        media.forEach((u) => this.add(bags, u));
        await Promise.race([waitMedia, sleep(deep ? 2000 : 800)]);
        const found = this.toObj(bags, candidate);
        if (found.m3u8.length || found.mp4.length || found.mpd.length || found.webm.length) break;
      } catch (e) {
        diagnostics.embeddedErrors = (diagnostics.embeddedErrors || 0) + 1;
      } finally {
        try {
          await child?.close();
        } catch (e) {}
      }
    }
  }
}

class SearchProvider {
  static TITLE_STOPWORDS = new Set([
    'watch', 'stream', 'online', 'episode', 'season', 'movie', 'movies', 'series', 'film', 'films', 'play', 'embed', 'player', 'video', 'full', 'hd', 'web', ' مترجم', 'فيلم', 'مسلسل', 'حلقة', 'مشاهدة', 'تحميل', 'مباشر', 'الحلقة', 'الموسم'
  ]);

  isInfoCandidate(url = '', source = '', title = '') {
    const u = String(url || '').toLowerCase();
    const s = String(source || '').toLowerCase();
    return (
      /wikipedia\.org|imdb\.com|themoviedb\.org|rottentomatoes\.com|fandom\.com|facebook\.com|instagram\.com/.test(u) ||
      /login|signin|sign-in|signup|sign-up|account|myaccount|myapps|microsoft\.com|myactivity\.google\.com|accounts\.google\.com|auth|oauth|sso|admin|dashboard|portal/.test(u) ||
      /guide|watch[- ]?order|review|news|trailer|price|marketcap|blockchain|crypto|article|blog/.test((u + ' ' + String(title || '')).toLowerCase()) ||
      /wikipedia|tmdb|imdb|omdb/.test(s) ||
      /\/wiki\/|\/person\//.test(u)
    );
  }

  add(map, item) {
    const url = item.url;
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (/duckduckgo\.com|google\.[a-z.]+\/search|bing\.com\/search|wikipedia\.org\/w\/api/i.test(url)) return;
    const infoCandidate = this.isInfoCandidate(url, item.source, item.title || item.name);
    const rawScore =
      (item.score != null ? item.score : titleSimilarity(item.query || '', item.title || item.name || '')) +
      (item.boost || 0);
    const descriptor = url + ' ' + (item.title || '') + ' ' + (item.name || '');
    const d = descriptor.toLowerCase();
    const watchBoost = /watch|stream|online|episode|season|movie|series|film|play|embed|player|video/.test(d)
      ? 0.15
      : 0;
    const informationPenalty =
      /wikipedia|imdb|themoviedb|rottentomatoes|fandom|news|review|trailer|facebook|instagram|login|signin|sign-in|signup|sign-up|account|myapps|auth|oauth|sso|admin|dashboard|portal/.test(d) ? 0.35 : 0;
    const score = Math.max(0, rawScore + watchBoost - informationPenalty);
    const candidateClass = infoCandidate ? 'info' : 'watch';
    const prev = map.get(url);
    if (!prev || score > prev.score) {
      map.set(url, {
        name: item.name || item.title || url,
        title: item.title || item.name || url,
        url,
        score,
        source: item.source || 'unknown',
        type: item.type || 'link',
        year: item.year || null,
        overview: item.overview || null,
        imdbId: item.imdbId || null,
        tmdbId: item.tmdbId || null,
        poster: item.poster || null,
        candidateClass,
        pageUrl: url
      });
    }
  }

  async searchDuckDuckGoAPI(query, map) {
    try {
      const { data } = await httpClient.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_redirect: 1, no_html: 1, skip_disambig: 1 },
        timeout: 10000
      });
      if (data && data.Heading && data.AbstractURL) {
        this.add(map, {
          name: data.Heading,
          title: data.Heading,
          url: data.AbstractURL,
          source: 'ddg-api',
          query,
          boost: 0.12,
          overview: data.Abstract || null
        });
      }
      for (const t of data && data.RelatedTopics ? data.RelatedTopics : []) {
        const items = t.Topics || [t];
        for (const sub of items) {
          if (sub.FirstURL && sub.Text) {
            this.add(map, {
              name: sub.Text.split(' - ')[0].slice(0, 120),
              title: sub.Text.slice(0, 160),
              url: sub.FirstURL,
              source: 'ddg-api',
              query,
              boost: 0.05
            });
          }
        }
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'DDG API failed');
    }
  }

  async searchDuckDuckGoHtml(query, map) {
    try {
      const { data } = await httpClient.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        timeout: 12000,
        headers: { Accept: 'text/html,application/xhtml+xml' }
      });
      const $ = cheerio.load(String(data || ''));
      $('.result').each((_, el) => {
        const a = $(el).find('a.result__a').first();
        const href = a.attr('href');
        const title = a.text().trim();
        const snippet = $(el).find('.result__snippet').text().trim();
        if (!href || !title) return;
        let url = href;
        try {
          const parsed = new URLParser(href);
          const uddg = parsed.searchParams.get('uddg');
          if (uddg) url = decodeURIComponent(uddg);
        } catch (e) {}
        if (!/^https?:\/\//i.test(url)) return;
        this.add(map, {
          name: title,
          title: snippet ? title + ' — ' + snippet : title,
          url,
          source: 'ddg-html',
          query,
          boost: 0.1,
          overview: snippet || null
        });
      });
    } catch (e) {
      logger.warn({ error: e.message }, 'DDG HTML search failed');
    }
  }

  async searchBing(query, map) {
    try {
      const { data } = await httpClient.get('https://www.bing.com/search', {
        params: { q: query, count: 10, setlang: 'ar' },
        timeout: 12000,
        headers: { Accept: 'text/html,application/xhtml+xml' }
      });
      const $ = cheerio.load(String(data || ''));
      $('li.b_algo').each((_, el) => {
        const a = $(el).find('h2 a').first();
        const href = a.attr('href');
        const title = a.text().trim();
        const snippet = $(el).find('.b_caption p, .b_paractl').first().text().trim();
        if (!href || !title) return;
        let url = href;
        try {
          const parsed = new URLParser(href);
          const encoded = parsed.searchParams.get('u');
          if (encoded && encoded.startsWith('a1')) {
            const decoded = Buffer.from(encoded.slice(2), 'base64url').toString('utf8');
            if (/^https?:\/\//i.test(decoded)) url = decoded;
          }
        } catch (e) {}
        if (!/^https?:\/\//i.test(url)) return;
        this.add(map, {
          name: title,
          title: snippet ? title + ' — ' + snippet : title,
          url,
          source: 'bing-html',
          query,
          boost: 0.12,
          overview: snippet || null
        });
      });
    } catch (e) {
      logger.warn({ error: e.message }, 'Bing search failed');
    }
  }

  async searchWikipedia(query, map) {
    try {
      const { data } = await httpClient.get('https://en.wikipedia.org/w/api.php', {
        params: { action: 'opensearch', search: query, limit: 8, namespace: 0, format: 'json' },
        timeout: 10000
      });
      const titles = (data && data[1]) || [];
      const descs = (data && data[2]) || [];
      const urls = (data && data[3]) || [];
      for (let i = 0; i < titles.length; i++) {
        this.add(map, {
          name: titles[i],
          title: descs[i] ? titles[i] + ' — ' + descs[i] : titles[i],
          url: urls[i],
          source: 'wikipedia',
          query,
          boost: 0.08
        });
      }
    } catch (e) {}
  }

  async searchTMDB(query, map) {
    if (!TMDB_API_KEY) return;
    try {
      const { data } = await httpClient.get('https://api.themoviedb.org/3/search/multi', {
        params: { api_key: TMDB_API_KEY, query, include_adult: false, language: 'en-US', page: 1 },
        timeout: 10000
      });
      for (const item of (data && data.results) || []) {
        if (item.media_type !== 'movie' && item.media_type !== 'tv') continue;
        const name = item.title || item.name;
        const year = String(item.release_date || item.first_air_date || '').slice(0, 4) || null;
        const tmdbUrl =
          item.media_type === 'movie'
            ? 'https://www.themoviedb.org/movie/' + item.id
            : 'https://www.themoviedb.org/tv/' + item.id;
        const poster = item.poster_path ? 'https://image.tmdb.org/t/p/w342' + item.poster_path : null;
        this.add(map, {
          name: year ? name + ' (' + year + ')' : name,
          title: name,
          url: tmdbUrl,
          source: 'tmdb',
          type: item.media_type,
          year,
          overview: item.overview || null,
          tmdbId: item.id,
          poster,
          query,
          boost: 0.18
        });
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'TMDB failed');
    }
  }

  async searchOMDb(query, map) {
    if (!OMDB_API_KEY) return;
    try {
      const { data } = await httpClient.get('https://www.omdbapi.com/', {
        params: { apikey: OMDB_API_KEY, s: query },
        timeout: 10000
      });
      if (data && data.Response === 'False') return;
      for (const item of (data && data.Search) || []) {
        if (!item.imdbID) continue;
        this.add(map, {
          name: item.Year ? item.Title + ' (' + item.Year + ')' : item.Title,
          title: item.Title,
          url: 'https://www.imdb.com/title/' + item.imdbID + '/',
          source: 'imdb-omdb',
          type: String(item.Type || 'movie').toLowerCase(),
          year: item.Year || null,
          imdbId: item.imdbID,
          poster: item.Poster && item.Poster !== 'N/A' ? item.Poster : null,
          query,
          boost: 0.16
        });
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'OMDb failed');
    }
  }

  isWatchCandidate(item = {}) {
    const descriptor = `${item.url || ''} ${item.title || ''} ${item.name || ''}`.toLowerCase();
    if (this.isInfoCandidate(item.url, item.source, item.title || item.name)) return false;
    return /watch|stream|online|episode|season|movie|movies|series|film|play|embed|player|video|\/movies?\//i.test(descriptor);
  }

  matchesRequestedTitle(query = '', item = {}) {
    const tokens = String(query || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((token) => token.length > 1 && !SearchProvider.TITLE_STOPWORDS.has(token));
    if (!tokens.length) return false;
    const descriptor = `${item.url || ''} ${item.title || ''} ${item.name || ''}`.toLowerCase();
    const hits = tokens.filter((token) => descriptor.includes(token));
    const numeric = tokens.filter((token) => /^\d{4}$|^s\d+$|^e\d+$/i.test(token));
    const numericHits = numeric.filter((token) => descriptor.includes(token));
    if (numeric.length && numericHits.length !== numeric.length) return false;
    return hits.length / tokens.length >= (tokens.length >= 3 ? 0.6 : 1);
  }

  async searchByName(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const map = new Map();
    const watchQuery = '"' + q + '" watch stream episode movie series';
    const arabicWatchQuery = q + ' مشاهدة فيلم مسلسل حلقة';
    await Promise.all([
      this.searchDuckDuckGoAPI(q, map),
      this.searchDuckDuckGoAPI(watchQuery, map),
      this.searchDuckDuckGoHtml(q, map),
      this.searchDuckDuckGoHtml(watchQuery, map),
      this.searchDuckDuckGoHtml(arabicWatchQuery, map),
      this.searchBing(q, map),
      this.searchBing(watchQuery, map),
      this.searchBing(arabicWatchQuery, map),
      this.searchWikipedia(q, map),
      this.searchTMDB(q, map),
      this.searchOMDb(q, map)
    ]);
    let results = [...map.values()].sort((a, b) => b.score - a.score);
    const strong = results.filter((r) => r.score >= 0.12);
    if (strong.length >= 2) results = strong;
    return results.slice(0, 15).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      title: r.title,
      url: r.url,
      pageUrl: r.pageUrl || r.url,
      matchScore: Math.round(r.score * 1000) / 1000,
      source: r.source,
      type: r.type,
      year: r.year,
      overview: r.overview,
      imdbId: r.imdbId,
      tmdbId: r.tmdbId,
      poster: r.poster,
      candidateClass: r.candidateClass || 'unknown'
    }));
  }
}

class CacheManager {
  constructor() {
    this.l1 = new Map();
    this.max = 80;
  }
  key(url, quality, deep) {
    return crypto.createHash('sha256').update(url + '::' + quality + '::' + (deep ? 1 : 0)).digest('hex');
  }
  async get(url, quality = 'auto', deep = false) {
    const k = this.key(url, quality, deep);
    if (this.l1.has(k)) {
      metrics.cacheHits.labels('l1').inc();
      return this.l1.get(k);
    }
    try {
      const raw = await redis.get('cache:' + k);
      if (raw) {
        metrics.cacheHits.labels('l2').inc();
        return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  }
  async set(url, data, quality = 'auto', deep = false) {
    const k = this.key(url, quality, deep);
    if (this.l1.size >= this.max) this.l1.delete(this.l1.keys().next().value);
    this.l1.set(k, data);
    try {
      await redis.setex('cache:' + k, 86400, JSON.stringify(data));
    } catch (e) {}
  }
}
const cacheManager = new CacheManager();

class SingleFlight {
  constructor() {
    this.map = new Map();
  }
  h(k) {
    return crypto.createHash('sha256').update(k).digest('hex');
  }
  get(k) {
    return this.map.get(this.h(k));
  }
  set(k, p) {
    const id = this.h(k);
    this.map.set(id, p);
    setTimeout(() => this.map.delete(id), 180000);
  }
  del(k) {
    if (k) this.map.delete(this.h(k));
  }
}
const singleFlight = new SingleFlight();

const extractionQueue = new Queue('vd-pro-v44', REDIS_URL, {
  settings: {
    stalledInterval: 20000,
    maxStalledCount: 1,
    lockDuration: JOB_LOCK_MS,
    lockRenewTime: Math.floor(JOB_LOCK_MS / 3)
  },
  defaultJobOptions: {
    removeOnComplete: 80,
    removeOnFail: 40,
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 }
  }
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
if (ALLOWED_ORIGINS.length) app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
else app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      metrics.httpDuration
        .labels(req.method, req.route?.path || req.path, res.statusCode)
        .observe((Date.now() - t0) / 1000);
    } catch (e) {}
  });
  next();
});

const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'No token', code: 'NO_TOKEN' });
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (db) {
      const user = await db.collection('users').findOne({ apiKey: decoded.apiKey });
      if (!user) return res.status(403).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
      req.user = user;
    } else {
      req.user = { _id: decoded.apiKey, plan: 'free', apiKey: decoded.apiKey };
    }
    next();
  } catch (e) {
    return res.status(403).json({ success: false, error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
};

function rateLimitKey(req) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
      if (decoded?.apiKey) return 'u:' + decoded.apiKey;
    }
  } catch (e) {}
  const id = req.user?._id?.toString?.() || req.user?._id;
  if (id) return 'u:' + id;
  return 'ip:' + (req.ip || 'unknown');
}

app.use(
  '/api/v1/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/api/v1/health',
    keyGenerator: rateLimitKey
  })
);

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    ready: startupReady,
    startupError: startupError ? 'STARTUP_DEGRADED' : null,
    name: 'Vd-Pro',
    version: '4.5.0',
    redis: redis.status,
    mongodb: db ? 'connected' : 'disconnected',
    limits: {
      hardExtractMs: HARD_EXTRACT_MS,
      navTimeoutMs: NAV_TIMEOUT_MS,
      jobProcessTimeoutMs: JOB_PROCESS_TIMEOUT_MS
    },
    searchProviders: {
      ddgApi: true,
      wikipedia: true,
      tmdb: !!TMDB_API_KEY,
      omdbImdb: !!OMDB_API_KEY
    },
    proxy: { configured: PROXIES.length > 0, count: PROXIES.length, checked: proxyManager.proxies.filter((p) => p.health.checked).length, available: proxyManager.proxies.filter((p) => p.health.available).length },
    mediaFlow: { configured: isMediaFlowProxyConfigured() },
    notes: {
      drm: 'Detected and reported; not decrypted',
      captcha: 'Detected and reported; not solved',
      signedUrls: 'TTL/referer via linkMeta when possible'
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'Missing fields' });
    if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Weak password' });
    if (!db) return res.status(503).json({ success: false, error: 'DB unavailable' });
    const normalized = String(email).trim().toLowerCase();
    if (await db.collection('users').findOne({ email: normalized })) {
      return res.status(400).json({ success: false, error: 'Email exists' });
    }
    const apiKey = crypto.randomBytes(32).toString('hex');
    await db.collection('users').insertOne({
      email: normalized,
      password: await bcrypt.hash(password, 12),
      apiKey,
      plan: 'free',
      createdAt: new Date()
    });
    const token = jwt.sign({ apiKey }, EFFECTIVE_JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ success: true, apiKey, token, plan: 'free' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Register failed' });
  }
});

app.get('/api/v1/extract', verifyToken, async (req, res) => {
  try {
    const { url, quality = 'auto', deep } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required', code: 'MISSING_URL' });
    const v = await SSRFValidator.validate(url);
    if (!v.valid) return res.status(400).json({ success: false, error: v.reason, code: 'INVALID_URL' });
    const deepFlag = deep === '1' || deep === 'true';
    const cached = await cacheManager.get(url, quality, deepFlag);
    if (cached) return res.json({ success: true, fromCache: true, ...applyMediaFlowProxy(cached) });
    const flightKey = 'ex:' + url + '::' + quality + '::' + (deepFlag ? 1 : 0);
    if (singleFlight.get(flightKey)) return res.status(202).json({ success: true, message: 'Processing', dedup: true });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const job = await withTimeout(
      extractionQueue.add(
        { type: 'extract', url, userId, quality, deep: deepFlag },
        { timeout: HARD_EXTRACT_MS + 20000, attempts: 2 }
      ),
      10000,
      'QUEUE_ADD_TIMEOUT'
    );
    singleFlight.set(flightKey, job.finished().catch(() => null));
    res.status(202).json({ success: true, jobId: job.id, statusUrl: '/api/v1/jobs/' + job.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/search', verifyToken, async (req, res) => {
  try {
    const { q, extract, quality = 'auto', deep } = req.query;
    if (!q || !String(q).trim()) return res.status(400).json({ success: false, error: 'q required' });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const doExtract = extract === '1' || extract === 'true';
    const job = await withTimeout(
      extractionQueue.add(
        {
          type: doExtract ? 'search_extract' : 'search',
          search: String(q).trim(),
          userId,
          quality,
          deep: deep === '1' || deep === 'true'
        },
        { timeout: doExtract ? HARD_EXTRACT_MS + 30000 : HARD_SEARCH_MS + 10000, attempts: 2 }
      ),
      10000,
      'QUEUE_ADD_TIMEOUT'
    );
    res.status(202).json({
      success: true,
      jobId: job.id,
      query: String(q).trim(),
      mode: doExtract ? 'search_and_extract' : 'search_only',
      statusUrl: '/api/v1/jobs/' + job.id
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/jobs/:jobId', verifyToken, async (req, res) => {
  try {
    const job = await withTimeout(extractionQueue.getJob(req.params.jobId), 8000, 'QUEUE_STATUS_TIMEOUT');
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    if (job.data && job.data.userId && String(job.data.userId) !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const state = await job.getState();
    let result = null;
    if (state === 'completed') {
      result = job.returnvalue != null ? job.returnvalue : job._returnvalue != null ? job._returnvalue : null;
    }
    res.json({
      success: true,
      jobId: job.id,
      state,
      result,
      attemptsMade: job.attemptsMade || 0,
      failedReason: state === 'failed' ? job.failedReason || null : null
    });
  } catch (e) {
    const queueError = /QUEUE_(?:ADD|STATUS)_TIMEOUT|Redis|connection|timeout/i.test(String(e.message || ''));
    res.status(queueError ? 503 : 500).json({
      success: false,
      error: queueError ? 'Queue unavailable' : e.message,
      code: queueError ? 'QUEUE_UNAVAILABLE' : 'JOB_STATUS_ERROR'
    });
  }
});

app.get('/api/v1/proxy-status', verifyToken, (req, res) => {
  res.json({ success: true, proxies: proxyManager.status() });
});

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup({ openapi: '3.0.0', info: { title: 'Vd-Pro', version: '4.5.0' } })
);

function classifyExtractionFailure(result, primaryError = null) {
  const d = { ...(result?.diagnostics || {}) };
  const code = result?.errorCode || primaryError?.code || 'EXTRACTION_ERROR';
  const mediaRequests = Number(d.mediaRequests || 0);
  const mediaCandidates = Number(d.mediaCandidates || d.responseMediaCandidates || 0);
  let failureClass = 'unknown';
  let strategy = 'generic-retry';
  if (d.captchaSuspected) { failureClass = 'bot-protection'; strategy = 'diagnose-page-protection'; }
  else if (d.drmSuspected || code === 'DRM_PROTECTED') { failureClass = 'protected-media'; strategy = 'report-protected-media'; }
  else if (code.includes('TIMEOUT') || d.timedOut) { failureClass = 'timeout'; strategy = mediaRequests ? 'validate-captured-media' : 'deep-iframe-network-retry'; }
  else if (mediaRequests === 0) { failureClass = 'no-media-requests'; strategy = 'network-or-blocked-page'; }
  else if (!result?.primaryUrl && (mediaRequests > 0 || mediaCandidates > 0)) { failureClass = 'media-detected-not-selected'; strategy = 'filter-validate-with-context'; }
  else if (code === 'NO_STREAM_FOUND') { failureClass = 'no-public-media'; strategy = 'dom-script-iframe-scan'; }
  d.failureClass = failureClass; d.failureStrategy = strategy; d.failureCode = code; d.mediaRequests = mediaRequests; d.mediaCandidates = mediaCandidates; d.failureObservedAt = new Date().toISOString();
  return d;
}

async function extractWithFallback(url, page, proxy, userId, options = {}) {
  const startedAt = Date.now();
  let primary = null;
  let primaryError = null;
  try {
    primary = await new VideoExtractor().extract(url, page, userId, options);
  } catch (error) {
    primaryError = error;
  }
  const primaryDiagnostics = classifyExtractionFailure(primary || { success: false, errorCode: primaryError?.code || 'EXTRACTION_ERROR' }, primaryError);
  const shouldFallback = Boolean(
    primaryError ||
    !primary?.success ||
    !primary?.primaryUrl ||
    ['EXTRACTION_TIMEOUT', 'EXTRACTION_ERROR', 'NO_STREAM_FOUND', 'STREAM_FOUND_BUT_UNPLAYABLE'].includes(primary?.errorCode)
  );
  if (!shouldFallback || !browserPool) { const out = primary || { success: false, error: primaryError?.message || 'Extraction failed', errorCode: primaryError?.code || 'EXTRACTION_ERROR' }; out.diagnostics = out.success ? (out.diagnostics || {}) : classifyExtractionFailure(out, primaryError); return out; }

  let fallbackCtx = null;
  try {
    const remaining = Math.max(5000, JOB_PROCESS_TIMEOUT_MS - (Date.now() - startedAt) - 5000);
    const budget = Math.min(FALLBACK_BUDGET_MS, remaining);
    const fallbackProxy = PROXIES.length ? proxyManager.getNext() : null;
    fallbackCtx = await browserPool.get(fallbackProxy);
    const cookies = await sessionManager.load(userId);
    const fallbackDeep = Boolean(options.deep || ['no-media-requests', 'timeout'].includes(primaryDiagnostics.failureClass) || Number(primaryDiagnostics.framesVisited || 0) < 2);
    const fallback = await withTimeout(
      runFallbackExtraction({ page: fallbackCtx.page, pageUrl: url, deep: fallbackDeep, quality: options.quality, cookies, headers: { referer: url } }),
      budget,
      'FALLBACK_EXTRACTION_TIMEOUT'
    );
    if (fallback.success) {
      return {
        ...fallback,
        duration: (primary?.duration || 0) + (fallback.duration || 0),
        diagnostics: { ...(primary?.diagnostics || {}), ...primaryDiagnostics, fallbackAttempted: true, fallbackSucceeded: true, fallbackStrategy: primaryDiagnostics.failureStrategy, fallbackDeep, fallbackDiagnostics: fallback.diagnostics, fallbackProxy: fallbackProxy ? { id: fallbackProxy.id } : null },
        source: 'vd-pro-fallback'
      };
    }
    if (primary) {
      return { ...primary, diagnostics: classifyExtractionFailure({ ...primary, diagnostics: { ...(primary.diagnostics || {}), fallbackAttempted: true, fallbackSucceeded: false, fallbackDiagnostics: fallback.diagnostics, fallbackErrorCode: fallback.errorCode } }) };
    }
    return fallback;
  } catch (error) {
    if (primary) return { ...primary, diagnostics: classifyExtractionFailure({ ...primary, diagnostics: { ...(primary.diagnostics || {}), fallbackAttempted: true, fallbackSucceeded: false, fallbackError: error.message, fallbackErrorCode: error.code || 'FALLBACK_ERROR' } }, primaryError) };
    const failed = { success: false, error: primaryError?.message || error.message, errorCode: primaryError?.code || error.code || 'EXTRACTION_ERROR', diagnostics: { fallbackAttempted: true, fallbackSucceeded: false, fallbackError: error.message } }; failed.diagnostics = classifyExtractionFailure(failed, primaryError); return failed;
  } finally {
    if (fallbackCtx) browserPool.release(fallbackCtx);
  }
}

async function processExtractionJob(job) {
  const jobStartedAt = Date.now();
  let ctx = null;
  let proxy = null;
  try {
    const userId = job.data.userId;

    if (job.data.type === 'search') {
      const results = await withTimeout(
        new SearchProvider().searchByName(job.data.search),
        HARD_SEARCH_MS,
        'SEARCH_TIMEOUT'
      );
      const sp = new SearchProvider();
      const watchCandidates = results.filter((r) => sp.isWatchCandidate(r) && r.candidateClass !== 'info' && sp.matchesRequestedTitle(job.data.search, r) && Number(r.matchScore ?? 0) >= 0.12);
      const infoCandidates = results.filter((r) => sp.isInfoCandidate(r.url, r.source) || r.candidateClass === 'info');
      return {
        success: results.length > 0,
        query: job.data.search,
        results,
        watchCandidates,
        infoCandidates,
        count: results.length,
        providers: ['ddg-api', 'wikipedia', TMDB_API_KEY ? 'tmdb' : null, OMDB_API_KEY ? 'omdb-imdb' : null].filter(
          Boolean
        )
      };
    }

    if (!browserPool || !startupReady) {
      try {
        await withTimeout(startupReadyPromise, Math.max(15000, NAV_TIMEOUT_MS + 15000), 'BROWSER_STARTING');
      } catch (e) {
        return { success: false, error: 'Browser is still starting; retry shortly', errorCode: e.code || 'BROWSER_STARTING', duration: 0 };
      }
    }
    proxy = PROXIES.length ? proxyManager.getNext() : null;
    ctx = await browserPool.get(proxy);
    const page = ctx.page;

    if (job.data.type === 'search_extract') {
      const results = await withTimeout(
        new SearchProvider().searchByName(job.data.search),
        HARD_SEARCH_MS,
        'SEARCH_TIMEOUT'
      );
      if (!results.length) {
        return { success: false, query: job.data.search, results: [], errorCode: 'NO_SEARCH_RESULTS' };
      }
      const searchProvider = new SearchProvider();
      const infoCandidates = results.filter(
        (r) => searchProvider.isInfoCandidate(r.url, r.source) || r.candidateClass === 'info'
      );
      const watchCandidates = results.filter(
        (r) => searchProvider.isWatchCandidate(r) && r.candidateClass !== 'info' && searchProvider.matchesRequestedTitle(job.data.search, r) && Number(r.matchScore ?? 0) >= 0.12
      );
      if (!watchCandidates.length) {
        return {
          success: false,
          query: job.data.search,
          watchCandidates: [],
          infoCandidates,
          searchResults: results.slice(0, 10),
          errorCode: 'NO_WATCH_CANDIDATE',
          error: 'Only informational pages found; no matching watch page to extract'
        };
      }
      const candidateAttempts = [];
      let selected = null;
      for (const candidate of watchCandidates.slice(0, 5)) {
        const remaining = Math.max(20000, JOB_PROCESS_TIMEOUT_MS - (Date.now() - jobStartedAt) - 5000);
        if (remaining < 12000 && candidateAttempts.length) break;
        try {
          const candidateResult = await withTimeout(
            extractWithFallback(candidate.url, page, proxy, userId, {
              quality: job.data.quality,
              deep: job.data.deep
            }),
            Math.min(HARD_EXTRACT_MS + 30000, remaining),
            'SEARCH_CANDIDATE_TIMEOUT'
          );
          const routed = applyMediaFlowProxy(candidateResult);
          candidateAttempts.push({ url: candidate.url, name: candidate.name, success: !!routed?.success, errorCode: routed?.errorCode || null });
          selected = { candidate, extraction: routed };
          if (routed?.success) break;
        } catch (error) {
          candidateAttempts.push({ url: candidate.url, name: candidate.name, success: false, errorCode: error.code || 'SEARCH_CANDIDATE_ERROR' });
        }
      }
      const chosen = selected || { candidate: watchCandidates[0], extraction: { success: false, errorCode: 'SEARCH_CANDIDATES_EXHAUSTED', error: 'Matching watch pages could not be extracted' } };
      return {
        success: !!chosen.extraction.success,
        query: job.data.search,
        matchedName: chosen.candidate.name,
        matchedUrl: chosen.candidate.url,
        pageUrl: chosen.candidate.pageUrl || chosen.candidate.url,
        watchCandidates: watchCandidates.slice(0, 10),
        infoCandidates: infoCandidates.slice(0, 10),
        searchResults: results.slice(0, 10),
        candidateAttempts,
        extraction: chosen.extraction
      };
    }

    const runOnCurrentProxy = async () => applyMediaFlowProxy(await extractWithFallback(job.data.url, ctx.page, proxy, userId, {
      quality: job.data.quality,
      deep: job.data.deep
    }));

    let result = await runOnCurrentProxy();
    const initialDiagnostics = { ...(result.diagnostics || {}) };
    initialDiagnostics.proxyUsed = proxy ? { id: proxy.id } : null;
    initialDiagnostics.proxySwitched = false;
    initialDiagnostics.proxyErrors = [];
    result.diagnostics = initialDiagnostics;

    const mediaRequests = Number(initialDiagnostics.mediaRequests || 0);
    const shouldProxyRetry = !result.success && PROXIES.length > 1 && (
      mediaRequests === 0 || result.errorCode === 'NO_STREAM_FOUND' || result.errorCode === 'STREAM_FOUND_BUT_UNPLAYABLE'
    ) && !initialDiagnostics.captchaSuspected && !initialDiagnostics.drmSuspected;
    if (shouldProxyRetry) {
      const retryProxy = proxyManager.getNext(proxy);
      const remaining = JOB_PROCESS_TIMEOUT_MS - (Date.now() - jobStartedAt);
      if (retryProxy && remaining > 20000) {
        const firstError = result.errorCode || initialDiagnostics.failureClass || 'PROXY_RETRY_TRIGGERED';
        browserPool.release(ctx);
        ctx = null;
        proxy = retryProxy;
        try {
          ctx = await browserPool.get(proxy);
          const retried = await withTimeout(runOnCurrentProxy(), Math.min(HARD_EXTRACT_MS, remaining - 5000), 'PROXY_RETRY_TIMEOUT');
          const retryDiagnostics = { ...(retried.diagnostics || {}) };
          retryDiagnostics.proxyUsed = { id: proxy.id };
          retryDiagnostics.proxySwitched = true;
          retryDiagnostics.proxyErrors = [firstError];
          retryDiagnostics.previousAttempt = initialDiagnostics;
          retried.diagnostics = retryDiagnostics;
          result = retried;
        } catch (retryError) {
          initialDiagnostics.proxySwitched = true;
          initialDiagnostics.proxyErrors = [firstError, retryError.code || retryError.message || 'PROXY_RETRY_FAILED'];
          initialDiagnostics.retryProxy = { id: retryProxy.id };
          result.diagnostics = initialDiagnostics;
        }
      }
    }

    metrics.extractionDuration.labels(result.success ? 'success' : 'failure').observe(result.duration || 0);
    if (result.success) {
      metrics.sourceSuccess.inc();
      proxyManager.success(proxy);
      const ttl = result.linkMeta?.ttlSeconds;
      const tooShortLived = result.linkMeta?.likelySigned && typeof ttl === 'number' && ttl > 0 && ttl < 120;
      if (!tooShortLived) {
        await cacheManager.set(job.data.url, result, job.data.quality || 'auto', !!job.data.deep);
      }
      if (db) {
        try {
          await db.collection('extractions').updateOne(
            { jobId: String(job.id) },
            {
              $set: {
                jobId: String(job.id),
                userId: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
                url: job.data.url,
                result,
                createdAt: new Date()
              }
            },
            { upsert: true }
          );
        } catch (e) {}
      }
    } else {
      metrics.sourceFailure.labels(result.errorCode || 'unknown').inc();
      proxyManager.fail(proxy);
    }

    singleFlight.del('ex:' + job.data.url + '::' + (job.data.quality || 'auto') + '::' + (job.data.deep ? 1 : 0));
    return result;
  } catch (error) {
    logger.error({ jobId: job.id, error: error.message }, 'Job failed');
    proxyManager.fail(proxy);
    if (job?.data?.url) {
      singleFlight.del('ex:' + job.data.url + '::' + (job.data.quality || 'auto') + '::' + (job.data.deep ? 1 : 0));
    }
    const code = error.code || (error.message === 'EXTRACTION_TIMEOUT' ? 'EXTRACTION_TIMEOUT' : 'JOB_EXCEPTION');
    return { success: false, error: error.message, errorCode: code, duration: 0, diagnostics: classifyExtractionFailure({ success: false, error: error.message, errorCode: code }, error) };
  } finally {
    if (ctx) browserPool.release(ctx);
  }
}

extractionQueue.process(2, async (job) => {
  try {
    return await withTimeout(processExtractionJob(job), JOB_PROCESS_TIMEOUT_MS, 'JOB_PROCESS_TIMEOUT');
  } catch (error) {
    logger.error({ jobId: job.id, error: error.message }, 'Job hard timeout');
    return {
      success: false,
      error: 'Job exceeded the maximum processing time',
      errorCode: error.code || 'JOB_PROCESS_TIMEOUT',
      duration: JOB_PROCESS_TIMEOUT_MS / 1000
    };
  }
});

const watchdogTimer = setInterval(async () => {
  try {
    const activeJobs = await extractionQueue.getJobs(['active'], 0, 100);
    const now = Date.now();
    for (const job of activeJobs) {
      const startedAt = Number(job.processedOn || job.timestamp || 0);
      if (!startedAt || now - startedAt <= WATCHDOG_MAX_AGE_MS) continue;
      try {
        await job.moveToFailed(new Error('WATCHDOG_TIMEOUT'), true);
        logger.warn({ jobId: job.id, ageMs: now - startedAt }, 'Watchdog failed stale active job');
      } catch (e) {
        logger.warn({ jobId: job.id, error: e.message }, 'Watchdog could not fail stale job');
      }
    }
  } catch (e) {
    logger.warn({ error: e.message }, 'Watchdog scan failed');
  }
}, WATCHDOG_INTERVAL_MS);
if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', async (ws, req) => {
  let uid = null;
  try {
    const u = new URL(req.url || '', 'http://' + req.headers.host);
    const token = u.searchParams.get('token');
    if (!token) return ws.close(4401, 'Unauthorized');
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (db) {
      const user = await db.collection('users').findOne({ apiKey: decoded.apiKey });
      if (!user) return ws.close(4403, 'Forbidden');
      uid = user._id.toString();
    } else uid = decoded.apiKey;
  } catch (e) {
    return ws.close(4401, 'Unauthorized');
  }
  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type !== 'job_status' || !data.jobId) return;
      const job = await extractionQueue.getJob(data.jobId);
      if (!job) return ws.send(JSON.stringify({ type: 'error', message: 'Not found' }));
      if (job.data && job.data.userId && String(job.data.userId) !== uid) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
      }
      const state = await job.getState();
      const result = state === 'completed' ? job.returnvalue || job._returnvalue || null : null;
      ws.send(JSON.stringify({ type: 'job_update', jobId: data.jobId, state, result }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
});

async function shutdown() {
  try {
    clearInterval(watchdogTimer);
    await new Promise((r) => httpServer.close(r));
    await browserPool?.closeAll();
    await redis.quit();
    await extractionQueue.close();
    if (mongoClient) await mongoClient.close();
    wss.close();
    process.exit(0);
  } catch (e) {
    process.exit(1);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer.listen(PORT, '0.0.0.0', () => {
  logger.info('Vd-Pro v4.5.0 listening on :' + PORT);
  console.log('VD-PRO v4.5.0 — listening early; browser warm-up in progress — same API');
});

(async () => {
  try {
    logger.info('Vd-Pro v4.5.0 starting...');
    proxyManager.checkAll().catch((e) => logger.warn({ error: e.message }, 'Proxy health check failed'));
    await connectDatabase();
    browserPool = new BrowserPool(BROWSER_POOL_COUNT);
    await browserPool.init();
    startupReady = true;
    startupReadyPromiseResolve(true);
    logger.info({ browsers: BROWSER_POOL_COUNT, contextsPerPool: BROWSER_CONTEXTS_PER_POOL }, 'Vd-Pro ready');
  } catch (e) {
    startupError = e;
    startupReadyPromiseReject(e);
    logger.error({ error: e.message }, 'Startup degraded');
    // Keep the HTTP health endpoint alive so Render can restart/retry without a hard process crash.
  }
})();

export default app;
