/**
 * Vd-Pro v4.1 — Stable Ultra
 * Fixes: hard extraction timeout, jobs never hang in active, always return result
 * Features: deep extract, HLS/MP4/DASH, multi-quality, subtitles when found,
 *           search via DDG API + Wikipedia + TMDB + OMDb/IMDb
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

config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/vd-pro';
const PROXIES = (process.env.PROXIES || '').split(',').map((p) => p.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';

const HARD_EXTRACT_MS = parseInt(process.env.HARD_EXTRACT_MS || '75000', 10);
const HARD_SEARCH_MS = parseInt(process.env.HARD_SEARCH_MS || '25000', 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '35000', 10);
const JOB_LOCK_MS = HARD_EXTRACT_MS + 45000;

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
    logger.info('✅ MongoDB connected');
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
redis.on('connect', () => logger.info('✅ Redis connected'));

class SSRFValidator {
  static PRIVATE = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fc00:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
    /^ff00:/i,
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
    if (/^(https?:|blob:|data:)/i.test(rel)) return rel;
    if (rel.startsWith('//')) return `https:${rel}`;
    return new URL(rel, base).href;
  } catch (e) {
    return null;
  }
}

function looksLikeMedia(url = '', ct = '') {
  const u = String(url || '').toLowerCase();
  const c = String(ct || '').toLowerCase();
  if (/\.(m3u8|mp4|webm|mpd|m4s|ts)(\?|#|$)/i.test(u)) return true;
  if (/\/hls\/|\/dash\/|manifest|playlist|master\.json/i.test(u)) return true;
  if (c.includes('mpegurl') || c.includes('dash+xml') || c.startsWith('video/') || c.includes('vnd.apple')) return true;
  return false;
}

function classifyMedia(url = '', ct = '') {
  const u = String(url || '').toLowerCase();
  const c = String(ct || '').toLowerCase();
  if (u.includes('.m3u8') || c.includes('mpegurl') || c.includes('vnd.apple')) return 'm3u8';
  if (u.includes('.mpd') || c.includes('dash+xml')) return 'mpd';
  if (u.includes('.webm') || c.includes('webm')) return 'webm';
  if (u.includes('.mp4') || c.includes('mp4') || c.startsWith('video/')) return 'mp4';
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

function rankScore(url) {
  const u = String(url || '').toLowerCase();
  let s = 0;
  if (u.includes('.mp4')) s += 55;
  if (u.includes('.m3u8')) s += 45;
  if (u.includes('.mpd')) s += 40;
  if (/2160|4k/.test(u)) s += 30;
  if (/1080|1920/.test(u)) s += 22;
  if (/720/.test(u)) s += 14;
  if (/480|360/.test(u)) s += 4;
  if (/preview|trailer|thumb|poster|sample/.test(u)) s -= 25;
  if (u.startsWith('blob:')) s -= 50;
  return s;
}

function pickByQuality(variants, quality = 'auto') {
  if (!variants?.length) return null;
  if (!quality || quality === 'auto') {
    return [...variants].sort((a, b) => rankScore(b.url) - rankScore(a.url))[0];
  }
  const q = String(quality).toLowerCase();
  return (
    variants.find(
      (v) => String(v.quality || '').toLowerCase().includes(q) || String(v.url || '').toLowerCase().includes(q)
    ) || variants[0]
  );
}

function titleSimilarity(a, b) {
  const na = String(a || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const nb = String(b || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

class HLSParser {
  static async fetchText(url) {
    const res = await httpClient.get(url, {
      maxContentLength: 2_000_000,
      headers: { Accept: '*/*' },
      timeout: 10000
    });
    return String(res.data || '');
  }

  static parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const meta = line.slice('#EXT-X-STREAM-INF:'.length);
      const bw = /BANDWIDTH=(\d+)/i.exec(meta);
      const res = /RESOLUTION=(\d+x\d+)/i.exec(meta);
      const name = /NAME="([^"]+)"/i.exec(meta);
      const next = (lines[i + 1] || '').trim();
      if (!next || next.startsWith('#')) continue;
      const abs = resolveUrl(baseUrl, next);
      if (!abs) continue;
      let quality = name?.[1] || null;
      if (!quality && res) {
        const h = parseInt(res[1].split('x')[1], 10);
        quality = h >= 2160 ? '2160p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : `${h}p`;
      }
      variants.push({
        url: abs,
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        resolution: res?.[1] || null,
        quality: quality || 'unknown',
        type: 'hls'
      });
    }
    return variants;
  }

  static parseSubtitles(text, baseUrl) {
    const subs = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/i.test(line)) continue;
      const name = /NAME="([^"]+)"/i.exec(line)?.[1];
      const lang = /LANGUAGE="([^"]+)"/i.exec(line)?.[1];
      const uri = /URI="([^"]+)"/i.exec(line)?.[1];
      if (!uri) continue;
      const abs = resolveUrl(baseUrl, uri);
      if (abs) subs.push({ url: abs, language: lang || null, label: name || lang || 'subtitle', type: 'hls' });
    }
    return subs;
  }

  static async enrich(m3u8Url) {
    try {
      const text = await this.fetchText(m3u8Url);
      if (!text.includes('#EXTM3U')) return { variants: [], subtitles: [] };
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
      health: { success: 0, failed: 0, consecutive: 0, available: true }
    }));
  }
  getNext() {
    if (!this.proxies.length) return null;
    const ok = this.proxies.filter((p) => p.health.available);
    if (!ok.length) {
      this.proxies.forEach((p) => {
        p.health.available = true;
        p.health.consecutive = 0;
      });
      return this.proxies[0];
    }
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
        const u = new URL(p.url.includes('://') ? p.url : `http://${p.url}`);
        if (u.username || u.password) safe = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
      } catch (e) {
        safe = '[redacted]';
      }
      return { url: safe, available: p.health.available, success: p.health.success, failed: p.health.failed };
    });
  }
}
const proxyManager = new ProxyManager();

class SessionManager {
  async load(userId) {
    if (!userId) return [];
    try {
      const c = await redis.get(`session:${userId}`);
      if (c) return JSON.parse(c).cookies || [];
    } catch (e) {}
    return [];
  }
  async save(userId, cookies) {
    if (!userId) return;
    try {
      await redis.setex(`session:${userId}`, 604800, JSON.stringify({ cookies }));
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
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8'
      }
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
        this.close(ctx);
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
    if (Date.now() - ctx.createdAt > 30 * 60 * 1000 || ctx.usage > 20) {
      this.close(ctx);
      return;
    }
    ctx.usage++;
    this.available.push(ctx);
  }
  close(ctx) {
    try {
      ctx.page?.close?.().catch(() => {});
      ctx.context?.close?.().catch(() => {});
    } catch (e) {}
  }
  async closeAll() {
    for (const c of this.available) this.close(c);
    for (const c of this.inUse.keys()) this.close(c);
  }
}

class BrowserPool {
  constructor(n = 2) {
    this.n = n;
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
      const pool = new BrowserContextPool(browser, 2);
      await pool.init();
      this.pools.push(pool);
    }
    logger.info({ browsers: this.n }, '✅ Browser pool ready');
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
    '.vjs-big-play-button',
    '.plyr__control--overlaid',
    '.jw-icon-display',
    'button.play',
    'video'
  ];
  let clicked = false;
  for (const frame of page.frames().slice(0, 8)) {
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (!el) continue;
        await el.click({ timeout: 800 }).catch(() => {});
        clicked = true;
      } catch (e) {}
    }
  }
  return clicked;
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
      other: new Set(),
      subtitles: new Set()
    };
  }

  add(bags, url, ct = '') {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:')) return;
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
          if (v) bags.subtitles.add(resolveUrl(base, v) || v);
        }
      }
    );
    const rules = [
      [/(https?:\/\/[^"'\\s<>{}]+?\.m3u8[^"'\\s<>{}]*)/gi, 'm3u8'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mp4[^"'\\s<>{}]*)/gi, 'mp4'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mpd[^"'\\s<>{}]*)/gi, 'mpd'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.webm[^"'\\s<>{}]*)/gi, 'webm'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.(vtt|srt)[^"'\\s<>{}]*)/gi, 'subtitles']
    ];
    for (const [re, key] of rules) {
      let m;
      while ((m = re.exec(html)) !== null) {
        if (key === 'subtitles') bags.subtitles.add(m[1]);
        else bags[key].add(m[1]);
      }
    }
    const cfg =
      /"(?:file|src|source|sources|hls|dash|playlist|stream|videoUrl|mediaUrl|playbackUrl)"\s*:\s*"([^"]+)"/gi;
    let cm;
    while ((cm = cfg.exec(html)) !== null) {
      const u = cm[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      this.add(bags, resolveUrl(base, u) || u);
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
      timedOut: false
    };

    const result = {
      success: false,
      primaryUrl: null,
      urls: { m3u8: [], mp4: [], webm: [], mpd: [], other: [] },
      variants: [],
      subtitles: [],
      qualities: [],
      duration: 0,
      strategy: null,
      quality,
      validated: false,
      error: null,
      errorCode: null,
      diagnostics,
      source: this.name,
      pageTitle: null,
      completedCleanly: false
    };

    const bags = this.empty();
    let finished = false;

    const onRequest = (req) => {
      try {
        diagnostics.requestsObserved++;
        const u = req.url();
        if (looksLikeMedia(u) || looksLikeSubtitle(u)) {
          diagnostics.mediaRequests++;
          this.add(bags, u);
        }
      } catch (e) {}
    };
    const onResponse = (response) => {
      try {
        const u = response.url();
        const ct = response.headers()['content-type'] || '';
        if (looksLikeMedia(u, ct) || looksLikeSubtitle(u, ct)) {
          diagnostics.mediaRequests++;
          this.add(bags, u, ct);
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
    page.context().on('page', onContextPage);

    const work = async () => {
      const cookies = await sessionManager.load(userId);
      if (cookies?.length) {
        try {
          await page.context().addCookies(cookies);
        } catch (e) {}
      }

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } catch (e) {
        diagnostics.navWarning = e.message;
      }

      try {
        result.pageTitle = await page.title();
        const snippet = await page.evaluate(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 1500) : ''));
        if (/captcha|cloudflare|verify you are human|attention required/i.test(String(result.pageTitle) + ' ' + snippet)) {
          diagnostics.captchaSuspected = true;
        }
      } catch (e) {}

      try {
        await page.waitForTimeout(400);
        await page.evaluate(() => window.scrollBy(0, 280));
      } catch (e) {}

      diagnostics.playClicked = await tryClickPlay(page);
      await page.waitForTimeout(deep ? 4500 : 2500);
      diagnostics.strategies.push('network');

      try {
        const html = await page.content();
        this.mineHtml(html, bags, pageUrl);
        diagnostics.strategies.push('dom');
      } catch (e) {}

      try {
        const mediaUrls = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('video').forEach((v) => {
            if (v.currentSrc) out.push(v.currentSrc);
            if (v.src) out.push(v.src);
            v.querySelectorAll('source').forEach((s) => {
              if (s.src) out.push(s.src);
            });
          });
          document.querySelectorAll('track').forEach((t) => {
            if (t.src) out.push(t.src);
          });
          (window.__vdCaptured || []).forEach((x) => out.push(x.url));
          return out;
        });
        mediaUrls.forEach((u) => this.add(bags, u));
        diagnostics.strategies.push('hooks');
      } catch (e) {}

      try {
        const frames = page.frames().slice(0, deep ? 10 : 6);
        diagnostics.framesVisited = page.frames().length;
        for (const frame of frames) {
          try {
            const html = await frame.content();
            this.mineHtml(html, bags, pageUrl);
            const fu = await frame.evaluate(() => {
              const out = [];
              document.querySelectorAll('video, audio, source').forEach((v) => {
                if (v.currentSrc) out.push(v.currentSrc);
                if (v.src) out.push(v.src);
                if (v.getAttribute('data-src')) out.push(v.getAttribute('data-src'));
              });
              document.querySelectorAll('iframe').forEach((f) => {
                if (f.src) out.push(f.src);
                if (f.getAttribute('data-src')) out.push(f.getAttribute('data-src'));
              });
              (window.__vdCaptured || []).forEach((x) => out.push(x.url));
              return out;
            });
            fu.forEach((u) => this.add(bags, u));
          } catch (e) {}
        }
        diagnostics.framesVisited = Math.max(diagnostics.framesVisited, page.frames().length);
        diagnostics.strategies.push('frames');
      } catch (e) {}

      let mid = this.toObj(bags, pageUrl);
      if (!(mid.m3u8.length || mid.mp4.length || mid.mpd.length || mid.webm.length)) {
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
        mid = this.toObj(bags, pageUrl);
      }

      if (deep && !(mid.m3u8.length || mid.mp4.length || mid.mpd.length || mid.webm.length)) {
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        await page.waitForTimeout(3500);
        try {
          const html2 = await page.content();
          this.mineHtml(html2, bags, pageUrl);
          for (const frame of page.frames().slice(0, 10)) {
            try { this.mineHtml(await frame.content(), bags, pageUrl); } catch (e) {}
          }
        } catch (e) {}
        diagnostics.strategies.push('deep-pass');
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
        page.context().off('page', onContextPage);
        for (const child of childPages) {
          child.off('request', onRequest);
          child.off('response', onResponse);
          await child.close().catch(() => {});
        }
      } catch (e) {}
    }

    result.urls = this.toObj(bags, pageUrl);

    const variants = [];
    const subtitles = [];
    for (const m of result.urls.m3u8.slice(0, 4)) {
      try {
        const en = await withTimeout(HLSParser.enrich(m), 8000, 'HLS_TIMEOUT');
        if (en.variants && en.variants.length) variants.push(...en.variants);
        else variants.push({ url: m, quality: 'unknown', bandwidth: 0, type: 'hls' });
        if (en.subtitles && en.subtitles.length) subtitles.push(...en.subtitles);
      } catch (e) {
        variants.push({ url: m, quality: 'unknown', bandwidth: 0, type: 'hls' });
      }
    }
    for (const m of result.urls.mp4) variants.push({ url: m, quality: 'mp4', bandwidth: 0, type: 'mp4' });
    for (const m of result.urls.webm) variants.push({ url: m, quality: 'webm', bandwidth: 0, type: 'webm' });
    for (const m of result.urls.mpd) variants.push({ url: m, quality: 'dash', bandwidth: 0, type: 'dash' });
    for (const s of result.urls.subtitles) {
      subtitles.push({ url: s, language: null, label: 'subtitle', type: 'file' });
    }

    variants.sort((a, b) => rankScore(b.url) - rankScore(a.url));
    result.variants = variants.slice(0, 20);
    result.subtitles = subtitles.slice(0, 15);
    result.qualities = [...new Set(result.variants.map((v) => v.quality).filter(Boolean))];

    const picked = pickByQuality(result.variants, quality);
    if (picked && picked.url) {
      result.primaryUrl = picked.url;
      result.success = true;
      result.strategy = diagnostics.strategies.join('+') || 'partial';
      result.error = null;
      result.errorCode = null;
      try {
        const v = await ResultValidator.validate(result.primaryUrl);
        result.validated = v.valid;
        if (!v.valid) result.validationReason = v.reason;
      } catch (e) {
        result.validated = false;
      }
    } else if (!result.errorCode) {
      result.error = diagnostics.captchaSuspected
        ? 'Possible bot protection; no media streams observed'
        : 'No video streams found';
      result.errorCode = diagnostics.captchaSuspected ? 'BOT_PROTECTION_SUSPECTED' : 'NO_STREAM_FOUND';
    }

    try {
      const c = await page.context().cookies();
      if (c.length) await sessionManager.save(userId, c);
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
      document.querySelectorAll('iframe, video, audio, source, a, [data-src], [data-url], [data-href]').forEach((el) => {
        ['src', 'href', 'data-src', 'data-url', 'data-href', 'data-play', 'data-player'].forEach((key) => add(el.getAttribute(key)));
      });
      document.querySelectorAll('script').forEach((s) => add(s.textContent || ''));
      return values;
    });
    const out = new Set();
    const add = (value) => {
      if (!value || typeof value !== 'string') return;
      const candidates = [value];
      const decoded = value.replace(/\u002F/g, '/').replace(/\\//g, '/');
      if (decoded !== value) candidates.push(decoded);
      for (const item of candidates) {
        const matches = item.match(/https?:\/\/[^\s"'<>`\\]+/gi) || [];
        for (const match of matches) {
          try {
            const u = new URLParser(match.replace(/[),;]+$/, ''));
            if (!['http:', 'https:'].includes(u.protocol)) continue;
            if (u.href === base.href) continue;
            const path = (u.pathname + u.search).toLowerCase();
            const likelyPlayer = /iframe|embed|player|play|watch|video|stream|source|file|download|m3u8|mp4|mpd/.test(path);
            if (u.hostname !== base.hostname || likelyPlayer) out.add(u.href);
          } catch (e) {}
        }
      }
    };
    for (const value of raw) add(value);
    return [...out].slice(0, deep ? 12 : 6);
  }

  async probeEmbeddedCandidates(page, candidates, bags, diagnostics, deep = false) {
    const context = page.context();
    for (const candidate of candidates.slice(0, deep ? 8 : 4)) {
      let child = null;
      try {
        child = await context.newPage();
        child.on('request', (req) => {
          try { if (looksLikeMedia(req.url())) this.add(bags, req.url()); } catch (e) {}
        });
        child.on('response', (res) => {
          try {
            const u = res.url();
            const ct = res.headers()['content-type'] || '';
            if (looksLikeMedia(u, ct)) this.add(bags, u, ct);
          } catch (e) {}
        });
        await child.goto(candidate, { waitUntil: 'domcontentloaded', timeout: Math.min(NAV_TIMEOUT_MS, 20000) });
        await tryClickPlay(child);
        await child.waitForTimeout(deep ? 2200 : 1200);
        this.mineHtml(await child.content(), bags, candidate);
        const media = await child.evaluate(() => {
          const out = [];
          document.querySelectorAll('video, audio, source').forEach((el) => {
            if (el.currentSrc) out.push(el.currentSrc);
            if (el.src) out.push(el.src);
            if (el.getAttribute('data-src')) out.push(el.getAttribute('data-src'));
          });
          (window.__vdCaptured || []).forEach((x) => out.push(x.url));
          return out;
        });
        media.forEach((u) => this.add(bags, u));
        diagnostics.framesVisited += child.frames().length;
        const found = this.toObj(bags, candidate);
        if (found.m3u8.length || found.mp4.length || found.mpd.length || found.webm.length) break;
      } catch (e) {
        diagnostics.embeddedErrors = (diagnostics.embeddedErrors || 0) + 1;
      } finally {
        try { await child?.close(); } catch (e) {}
      }
    }
  }
}

class ResultValidator {
  static async validate(url) {
    if (!url) return { valid: false, reason: 'NO_URL' };
    try {
      new URLParser(url);
    } catch (e) {
      return { valid: false, reason: 'INVALID_URL' };
    }
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 3,
        maxContentLength: 250000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Range: 'bytes=0-8192'
        }
      });
      if (res.status < 200 || res.status >= 400) return { valid: false, reason: 'INVALID_STATUS' };
      if (url.includes('.m3u8') && !String(res.data || '').includes('#EXTM3U')) {
        return { valid: false, reason: 'INVALID_M3U8' };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: 'VALIDATION_FAILED' };
    }
  }
}

class SearchProvider {
  add(map, item) {
    const url = item.url;
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (/duckduckgo\.com|google\.[a-z.]+\/search|bing\.com\/search|wikipedia\.org\/w\/api/i.test(url)) return;
    const rawScore =
      (item.score != null ? item.score : titleSimilarity(item.query || '', item.title || item.name || '')) +
      (item.boost || 0);
    const descriptor = `${url} ${item.title || ''} ${item.name || ''}`.toLowerCase();
    const watchBoost = /watch|stream|online|episode|season|movie|series|film|play|embed|player|video/.test(descriptor) ? 0.12 : 0;
    const informationPenalty = /wikipedia|imdb|themoviedb|rottentomatoes|fandom|news|review|trailer|facebook|instagram|youtube/.test(descriptor) ? 0.2 : 0;
    const score = Math.max(0, rawScore + watchBoost - informationPenalty);
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
          boost: 0.15,
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
          boost: 0.12
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
          boost: 0.22
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
        const imdbUrl = 'https://www.imdb.com/title/' + item.imdbID + '/';
        this.add(map, {
          name: item.Year ? item.Title + ' (' + item.Year + ')' : item.Title,
          title: item.Title,
          url: imdbUrl,
          source: 'imdb-omdb',
          type: String(item.Type || 'movie').toLowerCase(),
          year: item.Year || null,
          imdbId: item.imdbID,
          poster: item.Poster && item.Poster !== 'N/A' ? item.Poster : null,
          query,
          boost: 0.2
        });
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'OMDb failed');
    }
  }

  async searchByName(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const map = new Map();
    await Promise.all([
      this.searchDuckDuckGoAPI(q, map),
      this.searchDuckDuckGoAPI(q + ' series', map),
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
      poster: r.poster
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

const extractionQueue = new Queue('vd-pro-v41', REDIS_URL, {
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

app.use(
  '/api/v1/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyGenerator: (req) => {
      const id = req.user?._id?.toString?.() || req.user?._id;
      return id ? 'u:' + id : 'ip:' + req.ip;
    }
  })
);

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    name: 'Vd-Pro',
    version: '4.1.0',
    redis: redis.status,
    mongodb: db ? 'connected' : 'disconnected',
    limits: { hardExtractMs: HARD_EXTRACT_MS, navTimeoutMs: NAV_TIMEOUT_MS },
    searchProviders: {
      ddgApi: true,
      wikipedia: true,
      tmdb: !!TMDB_API_KEY,
      omdbImdb: !!OMDB_API_KEY
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
    if (cached) return res.json({ success: true, fromCache: true, ...cached });
    const flightKey = 'ex:' + url + '::' + quality + '::' + (deepFlag ? 1 : 0);
    if (singleFlight.get(flightKey)) return res.status(202).json({ success: true, message: 'Processing', dedup: true });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const job = await extractionQueue.add(
      { type: 'extract', url, userId, quality, deep: deepFlag },
      { timeout: HARD_EXTRACT_MS + 20000, attempts: 2 }
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
    const job = await extractionQueue.add(
      {
        type: doExtract ? 'search_extract' : 'search',
        search: String(q).trim(),
        userId,
        quality,
        deep: deep === '1' || deep === 'true'
      },
      { timeout: doExtract ? HARD_EXTRACT_MS + 30000 : HARD_SEARCH_MS + 10000, attempts: 2 }
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
    const job = await extractionQueue.getJob(req.params.jobId);
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
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/proxy-status', verifyToken, (req, res) => {
  res.json({ success: true, proxies: proxyManager.status() });
});

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup({ openapi: '3.0.0', info: { title: 'Vd-Pro', version: '4.1.0' } })
);

extractionQueue.process(2, async (job) => {
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
      return {
        success: results.length > 0,
        query: job.data.search,
        results,
        count: results.length,
        providers: ['ddg-api', 'wikipedia', TMDB_API_KEY ? 'tmdb' : null, OMDB_API_KEY ? 'omdb-imdb' : null].filter(
          Boolean
        )
      };
    }

    proxy = proxyManager.getNext();
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
      const preferred =
        results.find((r) => !/wikipedia\.org|themoviedb\.org|imdb\.com/i.test(r.url)) || results[0];
      const extraction = await new VideoExtractor().extract(preferred.url, page, userId, {
        quality: job.data.quality,
        deep: job.data.deep
      });
      return {
        success: !!extraction.success,
        query: job.data.search,
        matchedName: preferred.name,
        matchedUrl: preferred.url,
        pageUrl: preferred.pageUrl || preferred.url,
        searchResults: results.slice(0, 10),
        extraction
      };
    }

    const result = await new VideoExtractor().extract(job.data.url, page, userId, {
      quality: job.data.quality,
      deep: job.data.deep
    });

    metrics.extractionDuration.labels(result.success ? 'success' : 'failure').observe(result.duration || 0);
    if (result.success) {
      metrics.sourceSuccess.inc();
      proxyManager.success(proxy);
      await cacheManager.set(job.data.url, result, job.data.quality || 'auto', !!job.data.deep);
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
    const code = error.code || (error.message === 'EXTRACTION_TIMEOUT' ? 'EXTRACTION_TIMEOUT' : 'JOB_EXCEPTION');
    return {
      success: false,
      error: error.message,
      errorCode: code,
      duration: 0
    };
  } finally {
    if (ctx) browserPool.release(ctx);
  }
});

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

(async () => {
  try {
    logger.info('🚀 Vd-Pro v4.1 starting...');
    await connectDatabase();
    browserPool = new BrowserPool(2);
    await browserPool.init();
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info('Vd-Pro v4.1 on :' + PORT);
      console.log(`
╔══════════════════════════════════════════════════════════╗
║  VD-PRO v4.1 STABLE                                      ║
║  ✓ Hard timeout — no stuck active jobs                   ║
║  ✓ Always returns result object                          ║
║  ✓ m3u8 / mp4 / webm / mpd + multi-quality               ║
║  ✓ Subtitles when found                                  ║
║  ✓ Search: DDG + Wikipedia + TMDB + OMDb/IMDb            ║
║  HARD_EXTRACT_MS=${HARD_EXTRACT_MS}                                        ║
╚══════════════════════════════════════════════════════════╝
`);
    });
  } catch (e) {
    logger.error({ error: e.message }, 'Startup failed');
    process.exit(1);
  }
})();

export default app;
